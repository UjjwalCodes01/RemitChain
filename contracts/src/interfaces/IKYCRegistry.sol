// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IKYCRegistry
/// @notice Interface for the KYC Registry contract that manages user identity tiers and daily limits.
/// @dev Integrates with QIE Pass for off-chain identity verification via EIP-712 signed messages.
interface IKYCRegistry {
    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted when a user's KYC level is updated.
    /// @param user    The wallet address of the verified user.
    /// @param level   The new KYC tier (1 = phone OTP, 2 = full ID).
    event UserVerified(address indexed user, uint8 level);

    /// @notice Emitted when the trusted passOracle address changes.
    /// @param oldOracle The previous oracle address.
    /// @param newOracle The new oracle address.
    event PassOracleUpdated(address indexed oldOracle, address indexed newOracle);

    /// @notice Emitted when a tier daily limit is updated.
    /// @param tier  The KYC tier affected.
    /// @param limit The new daily limit in QUSD base units (6 decimals).
    event DailyLimitUpdated(uint8 indexed tier, uint256 limit);

    // =========================================================================
    // Errors
    // =========================================================================

    error InvalidSignature();
    error SignatureExpired(uint256 deadline, uint256 current);
    error InvalidPassOracle(address provided);
    error InvalidLevel(uint8 level);
    error CallerNotRemitChain(address caller);
    error InsufficientKYC(address user, uint8 needed, uint8 has);
    error DailyLimitExceeded(address user, uint256 limit, uint256 wouldBe);
    error ZeroAddress();

    // =========================================================================
    // External functions
    // =========================================================================

    /// @notice Verify a user's KYC level using a QIE Pass EIP-712 signed message.
    /// @param user      The wallet address to verify.
    /// @param newLevel  The KYC tier to assign (1 or 2).
    /// @param deadline  Unix timestamp after which the signature is invalid.
    /// @param signature EIP-712 signature from the trusted passOracle.
    function verifyUser(address user, uint8 newLevel, uint256 deadline, bytes calldata signature) external;

    /// @notice Returns the current KYC tier for a given address.
    /// @param user The wallet address to query.
    /// @return     KYC tier (0 = none, 1 = phone OTP, 2 = full ID).
    function getKYCLevel(address user) external view returns (uint8);

    /// @notice Returns the daily send limit for a given address based on their tier.
    /// @param user The wallet address to query.
    /// @return     Daily limit in QUSD base units (0 if unverified).
    function getDailyLimit(address user) external view returns (uint256);

    /// @notice Checks whether a send of `amount` is within the user's daily limit and records it.
    /// @dev    Only callable by the RemitChain contract. Reverts on breach.
    /// @param user   The sender's wallet address.
    /// @param amount The transfer amount in QUSD base units.
    function checkAndConsume(address user, uint256 amount) external;
}
