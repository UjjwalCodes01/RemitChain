// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IRemitChain
/// @notice Interface for the RemitChain router that orchestrates KYC, escrow, and claim flows.
interface IRemitChain {
    // =========================================================================
    // Types
    // =========================================================================

    /// @notice The lifecycle status of a remittance transfer.
    enum Status {
        NONE, // Transfer does not exist
        PENDING, // Funds locked in escrow, awaiting claim
        CLAIMED, // Recipient successfully claimed — terminal
        CANCELLED // Transfer cancelled / refunded — terminal
    }

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted when a new remittance is initiated.
    /// @param transferId         Unique transfer identifier.
    /// @param sender             Sender's wallet address.
    /// @param recipientPhoneHash keccak256(salt || E.164 phone number).
    /// @param amount             QUSD amount locked (6 decimals).
    /// @param expiry             Unix timestamp after which the transfer auto-expires.
    /// @param corridor           Numeric corridor identifier.
    event TransferInitiated(
        bytes32 indexed transferId,
        address indexed sender,
        bytes32 indexed recipientPhoneHash,
        uint256 amount,
        uint64 expiry,
        uint8 corridor
    );

    /// @notice Emitted when a recipient successfully claims a transfer.
    /// @param transferId Unique transfer identifier.
    /// @param recipient  Address that received the funds.
    event TransferClaimed(bytes32 indexed transferId, address indexed recipient);

    /// @notice Emitted when a transfer is cancelled and refunded.
    /// @param transferId Unique transfer identifier.
    /// @param cancelledBy The address that triggered the cancellation.
    event TransferCancelled(bytes32 indexed transferId, address indexed cancelledBy);

    // =========================================================================
    // Errors
    // =========================================================================

    error AmountBelowMinimum(uint256 provided, uint256 minimum);
    error TransferNotFound(bytes32 transferId);
    error TransferNotPending(bytes32 transferId, Status currentStatus);
    error TransferExpired(bytes32 transferId, uint64 expiry);
    error TransferNotExpired(bytes32 transferId, uint64 expiry);
    error UnauthorizedCancel(address caller, address sender);
    error InvalidOTPReveal(bytes32 transferId);
    error InvalidRecipientSignature();
    error SignatureExpired(uint256 deadline, uint256 current);
    error ZeroAddress();

    // =========================================================================
    // External functions
    // =========================================================================

    /// @notice Initiates a cross-border remittance.
    /// @param recipientPhoneHash keccak256(salt || E.164 phone) — phone number commitment.
    /// @param amount             QUSD amount to send (must be >= MIN_AMOUNT).
    /// @param otpCommitHash      keccak256(abi.encode(otpReveal, transferId, recipient)) — OTP commitment.
    /// @param corridor           Numeric identifier for the payout corridor.
    /// @return transferId        Unique identifier for this transfer.
    function sendRemittance(bytes32 recipientPhoneHash, uint256 amount, bytes32 otpCommitHash, uint8 corridor)
        external
        returns (bytes32 transferId);

    /// @notice Claims a pending remittance (called by the relayer on behalf of the recipient).
    /// @param transferId  Transfer to claim.
    /// @param otpReveal   The plaintext OTP preimage.
    /// @param recipient   The recipient's wallet address (receives funds).
    /// @param deadline    Signature expiry timestamp.
    /// @param recipientSig EIP-712 signature from `recipient` over the claim payload.
    function claimRemittance(
        bytes32 transferId,
        bytes32 otpReveal,
        address recipient,
        uint256 deadline,
        bytes calldata recipientSig
    ) external;

    /// @notice Cancels a pending transfer. Sender can cancel anytime; anyone else only after expiry.
    /// @param transferId Transfer to cancel.
    function cancelRemittance(bytes32 transferId) external;

    /// @notice Returns the status of a transfer.
    /// @param transferId Transfer to query.
    /// @return           Current status.
    function getTransferStatus(bytes32 transferId) external view returns (Status);
}
