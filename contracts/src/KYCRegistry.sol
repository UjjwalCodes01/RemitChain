// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IKYCRegistry} from "./interfaces/IKYCRegistry.sol";

/// @title KYCRegistry
/// @notice Maps wallet addresses to QIE Pass identity tiers and enforces daily send limits.
/// @dev    Tier assignment is done via EIP-712 signed messages from a trusted `passOracle`.
///         The passOracle is an off-chain QIE Pass verifier key.
///         // TODO(qie): Replace passOracle sig path with native QIE Pass on-chain verification
///         //             once the QIE Pass contract interface is published.
///
/// @custom:security Owner MUST be a TimelockController (min 2-day delay) controlled by a multisig.
///                  This prevents a single compromised key from silently altering user trust levels.
contract KYCRegistry is IKYCRegistry, Ownable2Step, Pausable, EIP712 {
    using ECDSA for bytes32;

    // =========================================================================
    // Types
    // =========================================================================

    /// @dev EIP-712 typehash for the VerifyUser signed payload.
    bytes32 private constant VERIFY_USER_TYPEHASH =
        keccak256("VerifyUser(address user,uint8 newLevel,uint256 deadline,uint256 nonce)");

    // =========================================================================
    // Constants
    // =========================================================================

    /// @notice KYC Tier 1 daily send limit (500 QUSD, 6 decimals).
    uint256 public constant DEFAULT_T1_LIMIT = 500e6;

    /// @notice KYC Tier 2 daily send limit (5000 QUSD, 6 decimals).
    uint256 public constant DEFAULT_T2_LIMIT = 5000e6;

    // =========================================================================
    // State
    // =========================================================================

    /// @notice The RemitChain router contract address. Only it may call checkAndConsume.
    /// @dev    Set at deployment and immutable — prevents any storage-manipulation attack
    ///         that could grant another contract the ability to consume daily limits.
    address public immutable remitChain;

    /// @notice The trusted QIE Pass oracle address that signs KYC attestations.
    /// @dev    Mutable (not immutable) so that a compromised oracle key can be rotated
    ///         via the TimelockController. Rotation requires a 2-day timelock window.
    address public passOracle;

    /// @notice KYC tier per wallet (0 = none, 1 = phone OTP, 2 = full ID).
    mapping(address => uint8) private _kycLevel;

    /// @notice Daily QUSD usage: user → dayId → amount consumed.
    /// @dev    dayId = block.timestamp / 1 days. Resets are implicit — a new dayId means zero usage.
    mapping(address => mapping(uint256 => uint256)) private _dailyUsage;

    /// @notice Daily send limit per KYC tier (in QUSD base units, 6 decimals).
    mapping(uint8 => uint256) public dailyLimits;

    /// @notice Per-user nonces for EIP-712 KYC attestation signatures. Prevents replay.
    mapping(address => uint256) public nonces;

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @notice Initialises the KYCRegistry.
    /// @param _passOracle  The trusted QIE Pass signer address.
    /// @param _remitChain  The RemitChain router address (immutable after deploy).
    /// @param _owner       Initial owner — should be a TimelockController in production.
    constructor(address _passOracle, address _remitChain, address _owner) Ownable(_owner) EIP712("KYCRegistry", "1") {
        if (_passOracle == address(0)) revert ZeroAddress();
        if (_remitChain == address(0)) revert ZeroAddress();

        passOracle = _passOracle;
        remitChain = _remitChain;

        dailyLimits[1] = DEFAULT_T1_LIMIT;
        dailyLimits[2] = DEFAULT_T2_LIMIT;
    }

    // =========================================================================
    // Modifiers
    // =========================================================================

    /// @dev Restricts a function to only the RemitChain router.
    modifier onlyRemitChain() {
        if (msg.sender != remitChain) revert CallerNotRemitChain(msg.sender);
        _;
    }

    // =========================================================================
    // External — state-changing
    // =========================================================================

    /// @notice Assigns a KYC tier to `user` using a QIE Pass EIP-712 attestation.
    /// @dev    Only the `passOracle` can produce valid signatures. Increments `nonces[user]`
    ///         to invalidate the consumed signature and prevent replay.
    ///         Pausable: emergency pause blocks new verifications (e.g., oracle compromise).
    /// @param user      Wallet to verify.
    /// @param newLevel  Tier to assign (must be 1 or 2).
    /// @param deadline  Signature expiry timestamp (unix).
    /// @param signature EIP-712 signature from `passOracle`.
    function verifyUser(address user, uint8 newLevel, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
    {
        if (user == address(0)) revert ZeroAddress();
        if (newLevel < 1 || newLevel > 2) revert InvalidLevel(newLevel);
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);

        // Build the EIP-712 digest
        bytes32 structHash = keccak256(abi.encode(VERIFY_USER_TYPEHASH, user, newLevel, deadline, nonces[user]));
        bytes32 digest = _hashTypedDataV4(structHash);

        // Verify signature — use tryRecover to handle malformed sigs without revert
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != passOracle) {
            revert InvalidSignature();
        }

        // CEI: update state before emitting
        nonces[user]++;
        _kycLevel[user] = newLevel;

        emit UserVerified(user, newLevel);
    }

    /// @notice Checks that `amount` is within `user`'s remaining daily limit and records the usage.
    /// @dev    Only callable by the RemitChain contract. CEI pattern applied.
    ///         Not pausable — this path is in the send flow which is separately gated by RemitChain.
    /// @param user   The sender's wallet address.
    /// @param amount The transfer amount in QUSD base units.
    function checkAndConsume(address user, uint256 amount) external onlyRemitChain {
        uint8 level = _kycLevel[user];
        if (level == 0) level = 1; // Default unverified users to Tier 1 limits

        uint256 limit = dailyLimits[level];
        uint256 dayId = block.timestamp / 1 days;
        uint256 currentUsage = _dailyUsage[user][dayId];
        uint256 newUsage = currentUsage + amount;

        if (newUsage > limit) revert DailyLimitExceeded(user, limit, newUsage);

        // CEI: update state first
        _dailyUsage[user][dayId] = newUsage;
    }

    // =========================================================================
    // External — owner-gated (must be called via TimelockController in production)
    // =========================================================================

    /// @notice Updates the trusted QIE Pass oracle address.
    /// @dev    Emits an event so off-chain monitoring can detect oracle rotations.
    ///         MUST be called via a 2-day TimelockController to allow community reaction time.
    /// @param newOracle The new oracle address.
    function setPassOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert ZeroAddress();
        address old = passOracle;
        passOracle = newOracle;
        emit PassOracleUpdated(old, newOracle);
    }

    /// @notice Updates the daily limit for a given KYC tier.
    /// @dev    MUST be called via a 2-day TimelockController.
    /// @param tier  The tier to update (1 or 2).
    /// @param limit New daily limit in QUSD base units (6 decimals).
    function setDailyLimit(uint8 tier, uint256 limit) external onlyOwner {
        if (tier < 1 || tier > 2) revert InvalidLevel(tier);
        dailyLimits[tier] = limit;
        emit DailyLimitUpdated(tier, limit);
    }

    /// @notice Pauses the contract, blocking new KYC verifications.
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

    /// @notice Returns the current KYC tier for `user`.
    /// @param user The wallet address to query.
    /// @return     KYC tier (0 = none, 1 = phone OTP, 2 = full ID).
    function getKYCLevel(address user) external view returns (uint8) {
        uint8 level = _kycLevel[user];
        return level == 0 ? 1 : level;
    }

    /// @notice Returns the maximum daily send amount for `user` based on their tier.
    /// @param user The wallet address to query.
    /// @return     Daily limit in QUSD base units (0 if unverified).
    function getDailyLimit(address user) external view returns (uint256) {
        uint8 level = _kycLevel[user];
        return dailyLimits[level == 0 ? 1 : level];
    }

    /// @notice Returns the current day's already-consumed send amount for `user`.
    /// @param user The wallet address to query.
    /// @return     Consumed amount today (QUSD base units).
    function getDailyUsage(address user) external view returns (uint256) {
        uint256 dayId = block.timestamp / 1 days;
        return _dailyUsage[user][dayId];
    }

    // =========================================================================
    // Public — EIP-712 domain
    // =========================================================================

    /// @notice Returns the EIP-712 domain separator used by this contract.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
