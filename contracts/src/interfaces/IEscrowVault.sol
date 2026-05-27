// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IEscrowVault
/// @notice Interface for the EscrowVault contract that holds QUSD for pending transfers.
/// @dev Only the RemitChain contract (set at deployment) can move funds.
interface IEscrowVault {
    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted when funds are locked for a new transfer.
    /// @param transferId Unique transfer identifier.
    /// @param sender     The address that sent the funds.
    /// @param amount     Amount of QUSD locked (6 decimals).
    event FundsLocked(bytes32 indexed transferId, address indexed sender, uint256 amount);

    /// @notice Emitted when funds are released to a recipient after a successful claim.
    /// @param transferId Unique transfer identifier.
    /// @param recipient  Address that received the funds.
    /// @param netAmount  Amount sent to recipient (after fee deduction).
    /// @param fee        Fee sent to treasury.
    event FundsReleased(bytes32 indexed transferId, address indexed recipient, uint256 netAmount, uint256 fee);

    /// @notice Emitted when funds are refunded to the original sender.
    /// @param transferId Unique transfer identifier.
    /// @param sender     Address that received the refund.
    /// @param amount     Full amount refunded.
    event FundsRefunded(bytes32 indexed transferId, address indexed sender, uint256 amount);

    /// @notice Emitted when the fee basis points are updated.
    /// @param oldFeeBps Previous fee in basis points.
    /// @param newFeeBps New fee in basis points.
    event FeeBpsUpdated(uint16 oldFeeBps, uint16 newFeeBps);

    /// @notice Emitted when the fee treasury address is updated.
    /// @param oldTreasury Previous treasury address.
    /// @param newTreasury New treasury address.
    event FeeTreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    // =========================================================================
    // Errors
    // =========================================================================

    error CallerNotRemitChain(address caller);
    error TransferIdCollision(bytes32 transferId);
    error TransferIdNotFound(bytes32 transferId);
    error FeeBpsExceedsMax(uint16 provided, uint16 max);
    error ZeroAddress();
    error ZeroAmount();

    // =========================================================================
    // External functions
    // =========================================================================

    /// @notice Locks QUSD from `sender` for a given `transferId`.
    /// @dev    Only callable by RemitChain. Reverts if transferId already exists.
    /// @param transferId Unique transfer identifier.
    /// @param sender     The address whose QUSD is pulled (must have approved this vault).
    /// @param amount     Amount to lock in QUSD base units.
    function lockFunds(bytes32 transferId, address sender, uint256 amount) external;

    /// @notice Releases locked QUSD to `recipient`, deducting the protocol fee.
    /// @dev    Only callable by RemitChain.
    /// @param transferId Unique transfer identifier.
    /// @param recipient  Address to receive the net amount.
    function releaseFunds(bytes32 transferId, address recipient) external;

    /// @notice Refunds the full locked amount to `sender`.
    /// @dev    Only callable by RemitChain. Not pausable — refunds must always succeed.
    /// @param transferId Unique transfer identifier.
    /// @param sender     Address to refund.
    function refundFunds(bytes32 transferId, address sender) external;

    /// @notice Returns the amount of QUSD locked for a specific transferId.
    /// @param transferId Unique transfer identifier.
    /// @return           Locked amount in QUSD base units.
    function lockedBalance(bytes32 transferId) external view returns (uint256);

    /// @notice Returns the total QUSD currently locked across all pending transfers.
    /// @return Total locked amount in QUSD base units.
    function totalLocked() external view returns (uint256);
}
