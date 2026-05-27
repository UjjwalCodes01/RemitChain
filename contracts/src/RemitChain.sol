// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IRemitChain} from "./interfaces/IRemitChain.sol";
import {IKYCRegistry} from "./interfaces/IKYCRegistry.sol";
import {IEscrowVault} from "./interfaces/IEscrowVault.sol";
import {TransferId} from "./libraries/TransferId.sol";

/// @title RemitChain
/// @notice Router that orchestrates KYC, escrow, and claim flows for cross-border remittances.
/// @dev    This contract is the sole entry point for senders and the relayer.
///         It coordinates KYCRegistry (identity) and EscrowVault (fund custody).
///
/// @custom:security Money-movement invariants:
///   1. Escrow can only release to the intended recipient (commit-reveal + recipient EIP-712 sig).
///   2. A malicious relayer cannot redirect funds — `recipient` is bound in the OTP commit hash
///      AND the claim requires a valid EIP-712 signature from that same `recipient` address.
///   3. Status transitions are one-way: NONE→PENDING→(CLAIMED|CANCELLED). Terminal states are final.
///   4. `cancelRemittance` is NOT pausable — users can always recover after timeout.
///
/// @custom:security Owner MUST be a TimelockController (min 2-day delay) controlled by a multisig.
contract RemitChain is IRemitChain, Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using TransferId for address;

    // =========================================================================
    // Types
    // =========================================================================

    /// @dev EIP-712 typehash for the recipient claim authorization payload.
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("ClaimRemittance(bytes32 transferId,address recipient,uint256 deadline,uint256 nonce)");

    /// @notice Full transfer record stored on-chain.
    struct Transfer {
        address sender;
        bytes32 recipientPhoneHash; // keccak256(salt || E.164 phone number)
        bytes32 otpCommitHash; // keccak256(abi.encode(otpReveal, transferId, recipient))
        uint256 amount;
        uint64 expiry;
        uint8 corridor;
        Status status;
    }

    // =========================================================================
    // Constants
    // =========================================================================

    /// @notice Claim window duration: 48 hours from transfer initiation.
    uint256 public constant CLAIM_WINDOW = 48 hours;

    /// @notice Minimum transfer amount: 1 QUSD (6 decimals).
    uint256 public constant MIN_AMOUNT = 1e6;

    // =========================================================================
    // Immutables
    // =========================================================================

    /// @notice KYCRegistry contract. Immutable post-deploy.
    IKYCRegistry public immutable kyc;

    /// @notice EscrowVault contract. Immutable post-deploy.
    IEscrowVault public immutable vault;

    /// @notice QUSD stablecoin contract. Immutable post-deploy.
    IERC20 public immutable QUSD;

    // =========================================================================
    // State
    // =========================================================================

    /// @notice All transfer records keyed by transferId.
    mapping(bytes32 => Transfer) public transfers;

    /// @notice Per-sender nonces for transferId generation. Monotonically increasing.
    mapping(address => uint256) public senderNonces;

    /// @notice Per-recipient nonces for claim EIP-712 signatures. Prevents claim-sig replay.
    mapping(address => uint256) public recipientNonces;

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @notice Initialises RemitChain and wires its dependencies.
    /// @param _kyc        KYCRegistry contract address.
    /// @param _vault      EscrowVault contract address.
    /// @param _qusd       QUSD ERC20 token contract address.
    /// @param _owner      Initial owner — should be a TimelockController in production.
    constructor(address _kyc, address _vault, address _qusd, address _owner) Ownable(_owner) EIP712("RemitChain", "1") {
        if (_kyc == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();
        if (_qusd == address(0)) revert ZeroAddress();

        kyc = IKYCRegistry(_kyc);
        vault = IEscrowVault(_vault);
        QUSD = IERC20(_qusd);
    }

    // =========================================================================
    // External — sender-facing
    // =========================================================================

    /// @notice Initiates a cross-border remittance. Sender must have pre-approved `vault`.
    /// @dev    Flow: KYC check + daily limit → generate transferId → store transfer → lock escrow.
    ///         CEI: all state written before vault.lockFunds (external call).
    ///         Pausable: new sends blocked during emergency.
    ///
    /// @custom:security The `otpCommitHash` MUST include the intended `recipient` address (computed
    ///                  off-chain before the send). This binds the OTP to a specific recipient,
    ///                  preventing a front-runner who sees `otpReveal` in the mempool from
    ///                  redirecting funds to themselves. See `claimRemittance` for the reveal check.
    ///
    /// @param recipientPhoneHash keccak256(salt || E.164 phone) — opaque phone commitment.
    /// @param amount             QUSD amount to send (>= MIN_AMOUNT).
    /// @param otpCommitHash      keccak256(abi.encode(otpReveal, transferId, recipient)).
    /// @param corridor           Numeric payout corridor identifier.
    /// @return transferId        Unique identifier for this transfer.
    function sendRemittance(bytes32 recipientPhoneHash, uint256 amount, bytes32 otpCommitHash, uint8 corridor)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 transferId)
    {
        if (amount < MIN_AMOUNT) revert AmountBelowMinimum(amount, MIN_AMOUNT);

        // KYC check + consume daily limit (reverts on breach)
        kyc.checkAndConsume(msg.sender, amount);

        // Generate collision-proof, chain-bound, nonce-monotonic transferId.
        // Post-increment nonce so the next send gets a different ID.
        transferId = TransferId.generate(msg.sender, senderNonces[msg.sender]++, block.chainid, address(this));

        // forge-lint: disable-next-line(unsafe-typecast)
        // Safe: block.timestamp + 48h << type(uint64).max (year ~292 billion)
        uint64 expiry = uint64(block.timestamp + CLAIM_WINDOW);

        // CEI: write all state before calling vault (external contract)
        transfers[transferId] = Transfer({
            sender: msg.sender,
            recipientPhoneHash: recipientPhoneHash,
            otpCommitHash: otpCommitHash,
            amount: amount,
            expiry: expiry,
            corridor: corridor,
            status: Status.PENDING
        });

        emit TransferInitiated(transferId, msg.sender, recipientPhoneHash, amount, expiry, corridor);

        // External call last — pull QUSD from sender into vault
        vault.lockFunds(transferId, msg.sender, amount);
    }

    /// @notice Claims a pending remittance. Intended to be called by the off-chain relayer.
    /// @dev    Dual-key security model:
    ///         1. OTP reveal: `otpReveal` must hash with `transferId` and `recipient` to produce
    ///            the stored `otpCommitHash` — proves knowledge of the OTP AND binds to recipient.
    ///         2. Recipient signature: EIP-712 signature from `recipient` over (transferId, recipient,
    ///            deadline, nonce) — even a compromised relayer cannot redirect funds.
    ///         CEI: set status CLAIMED before calling vault.releaseFunds.
    ///         Pausable: new claims blocked during emergency (but refunds remain open).
    ///
    /// @param transferId   Transfer to claim.
    /// @param otpReveal    The OTP preimage (6-digit code as bytes32).
    /// @param recipient    The recipient's wallet address (receives funds).
    /// @param deadline     Recipient signature expiry timestamp.
    /// @param recipientSig EIP-712 signature from `recipient`.
    function claimRemittance(
        bytes32 transferId,
        bytes32 otpReveal,
        address recipient,
        uint256 deadline,
        bytes calldata recipientSig
    ) external nonReentrant whenNotPaused {
        if (recipient == address(0)) revert ZeroAddress();

        Transfer storage t = transfers[transferId];
        if (t.status == Status.NONE) revert TransferNotFound(transferId);
        if (t.status != Status.PENDING) revert TransferNotPending(transferId, t.status);
        if (block.timestamp >= t.expiry) revert TransferExpired(transferId, t.expiry);
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);

        // Verify OTP commit-reveal. The hash includes recipient to prevent front-run redirect.
        bytes32 expectedCommit = keccak256(abi.encode(otpReveal, transferId, recipient));
        if (expectedCommit != t.otpCommitHash) revert InvalidOTPReveal(transferId);

        // Verify recipient's EIP-712 signature authorizing this specific claim.
        // Includes a nonce to prevent this signature from being replayed on a different transfer.
        bytes32 structHash =
            keccak256(abi.encode(CLAIM_TYPEHASH, transferId, recipient, deadline, recipientNonces[recipient]));
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, recipientSig);
        if (err != ECDSA.RecoverError.NoError || recovered != recipient) {
            revert InvalidRecipientSignature();
        }

        // CEI: update all state before external calls
        t.status = Status.CLAIMED;
        recipientNonces[recipient]++;

        emit TransferClaimed(transferId, recipient);

        // External call last
        vault.releaseFunds(transferId, recipient);
    }

    /// @notice Cancels a pending transfer and refunds QUSD to the sender.
    /// @dev    Sender can cancel at any time (before OR after expiry).
    ///         Anyone else can cancel only AFTER expiry — enabling recipient-side recovery
    ///         if the sender is unresponsive.
    ///         NOT pausable — users must always be able to recover funds.
    ///         CEI: set status CANCELLED before calling vault.refundFunds.
    /// @param transferId Transfer to cancel.
    function cancelRemittance(bytes32 transferId) external nonReentrant {
        Transfer storage t = transfers[transferId];
        if (t.status == Status.NONE) revert TransferNotFound(transferId);
        if (t.status != Status.PENDING) revert TransferNotPending(transferId, t.status);

        bool isSender = msg.sender == t.sender;
        bool isExpired = block.timestamp >= t.expiry;

        if (!isSender && !isExpired) {
            revert UnauthorizedCancel(msg.sender, t.sender);
        }

        address originalSender = t.sender; // cache before state change

        // CEI: update state before external call
        t.status = Status.CANCELLED;

        emit TransferCancelled(transferId, msg.sender);

        // External call last
        vault.refundFunds(transferId, originalSender);
    }

    // =========================================================================
    // External — EIP-2612 permit variant (single-tx UX, prevents approval-race)
    // =========================================================================

    /// @notice Initiates a remittance using EIP-2612 permit for a single-transaction UX.
    /// @dev    Calls `IERC20Permit.permit` to set the vault's allowance atomically, then
    ///         proceeds identically to `sendRemittance`. This eliminates the approval-race
    ///         attack vector where a front-runner could exploit a pending approval tx.
    ///
    ///         // TODO(qie): Confirm QUSD implements EIP-2612. If not, remove this function
    ///         //             and document that users must approve separately.
    ///
    /// @param recipientPhoneHash See `sendRemittance`.
    /// @param amount             See `sendRemittance`.
    /// @param otpCommitHash      See `sendRemittance`.
    /// @param corridor           See `sendRemittance`.
    /// @param permitDeadline     EIP-2612 permit deadline.
    /// @param v                  Permit signature component.
    /// @param r                  Permit signature component.
    /// @param s                  Permit signature component.
    /// @return transferId        Unique identifier for this transfer.
    function sendRemittanceWithPermit(
        bytes32 recipientPhoneHash,
        uint256 amount,
        bytes32 otpCommitHash,
        uint8 corridor,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused returns (bytes32 transferId) {
        if (amount < MIN_AMOUNT) revert AmountBelowMinimum(amount, MIN_AMOUNT);

        // Apply permit — sets vault's allowance atomically. Safe to call even if permit was
        // already granted (it will simply overwrite with the same or higher allowance).
        IERC20Permit(address(QUSD)).permit(msg.sender, address(vault), amount, permitDeadline, v, r, s);

        // KYC check + consume daily limit
        kyc.checkAndConsume(msg.sender, amount);

        // Generate transferId
        transferId = TransferId.generate(msg.sender, senderNonces[msg.sender]++, block.chainid, address(this));

        // forge-lint: disable-next-line(unsafe-typecast)
        // Safe: block.timestamp + 48h << type(uint64).max (year ~292 billion)
        uint64 expiry = uint64(block.timestamp + CLAIM_WINDOW);

        // CEI: write state before external calls
        transfers[transferId] = Transfer({
            sender: msg.sender,
            recipientPhoneHash: recipientPhoneHash,
            otpCommitHash: otpCommitHash,
            amount: amount,
            expiry: expiry,
            corridor: corridor,
            status: Status.PENDING
        });

        emit TransferInitiated(transferId, msg.sender, recipientPhoneHash, amount, expiry, corridor);

        vault.lockFunds(transferId, msg.sender, amount);
    }

    // =========================================================================
    // External — owner-gated
    // =========================================================================

    /// @notice Pauses the contract, blocking new sends and claims (but NOT cancellations).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses the contract.
    function unpause() external onlyOwner {
        _unpause();
    }

    // =========================================================================
    // External — view
    // =========================================================================

    /// @notice Returns the current status of a transfer.
    /// @param transferId Transfer to query.
    /// @return           Current status enum value.
    function getTransferStatus(bytes32 transferId) external view returns (Status) {
        return transfers[transferId].status;
    }

    /// @notice Returns the full Transfer struct for a given transferId.
    /// @param transferId Transfer to query.
    /// @return           The Transfer struct.
    function getTransfer(bytes32 transferId) external view returns (Transfer memory) {
        return transfers[transferId];
    }

    /// @notice Returns the EIP-712 domain separator for this contract.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
