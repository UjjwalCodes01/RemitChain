// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title TransferId
/// @notice Library for generating collision-proof, chain-bound transfer identifiers.
/// @dev    The transferId is a function of (sender, nonce, chainId, contract address).
///         This makes it:
///         - Unique: two sends by the same sender always produce different IDs (nonce monotonic).
///         - Chain-bound: replay on another EVM chain produces a different ID.
///         - Contract-bound: replay against a redeployed contract produces a different ID.
///         - Unpredictable: an observer cannot predict future IDs without knowing future nonces.
library TransferId {
    /// @notice Generates a unique transfer identifier.
    /// @param sender    The initiating sender address.
    /// @param nonce     The sender's current nonce (consumed before this call).
    /// @param chainId   The current chain ID (block.chainid).
    /// @param self      The calling contract's address.
    /// @return id       A 32-byte unique identifier.
    function generate(address sender, uint256 nonce, uint256 chainId, address self) internal pure returns (bytes32 id) {
        id = keccak256(abi.encode(sender, nonce, chainId, self));
    }
}
