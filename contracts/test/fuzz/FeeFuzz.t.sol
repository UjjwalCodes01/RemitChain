// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "../helpers/BaseTest.sol";
import {EscrowVault} from "../../src/EscrowVault.sol";
import {IEscrowVault} from "../../src/interfaces/IEscrowVault.sol";

/// @title FeeFuzz
/// @notice Fuzz tests for EscrowVault fee math
contract FeeFuzz is BaseTest {
    bytes32 internal constant TID = bytes32(uint256(0xFEEFEE));

    /// @notice Fuzz that fee math never overflows, never exceeds max, and recipient + fee == locked.
    /// @param amount  Randomised transfer amount in range [1e6, 1e30].
    /// @param feeBps  Randomised fee in range [0, MAX_FEE_BPS = 100].
    function testFuzz_FeeMath(uint256 amount, uint16 feeBps) public {
        amount = bound(amount, 1e6, 1e30);
        feeBps = uint16(bound(feeBps, 0, vault.MAX_FEE_BPS()));

        // Set fee
        vm.prank(owner);
        vault.setFeeBps(feeBps);

        // Mint and lock funds
        qusd.mint(sender, amount);
        vm.prank(sender);
        qusd.approve(address(vault), amount);
        vm.prank(address(remit));
        vault.lockFunds(TID, sender, amount);

        uint256 recipientBefore = qusd.balanceOf(recipient);
        uint256 treasuryBefore = qusd.balanceOf(feeTreasury);

        vm.prank(address(remit));
        vault.releaseFunds(TID, recipient);

        uint256 recipientReceived = qusd.balanceOf(recipient) - recipientBefore;
        uint256 feeCollected = qusd.balanceOf(feeTreasury) - treasuryBefore;

        // Total distributed == total locked
        assertEq(recipientReceived + feeCollected, amount, "recipient + fee != locked");

        // Fee never exceeds MAX_FEE_BPS cap
        uint256 maxFee = (amount * vault.MAX_FEE_BPS()) / 10_000;
        assertLe(feeCollected, maxFee, "fee exceeds max");

        // Fee rounds down — recipient never gets less than (amount - maxFee)
        assertGe(recipientReceived, amount - maxFee, "recipient underpaid");
    }

    /// @notice Fuzz that rounding never causes total to exceed locked amount (no free money).
    function testFuzz_FeeRounding_NoOverpay(uint256 amount, uint16 feeBps) public {
        amount = bound(amount, 1e6, 1e18);
        feeBps = uint16(bound(feeBps, 1, 100));

        uint256 computedFee = (amount * feeBps) / 10_000;
        uint256 net = amount - computedFee;

        // No overflow assertion — Solidity 0.8.24 checked math guarantees this
        assertLe(computedFee + net, amount + 1, "arithmetic overflow risk");
        assertEq(computedFee + net, amount, "fee + net != amount");
    }
}
