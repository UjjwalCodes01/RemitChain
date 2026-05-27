// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "../helpers/BaseTest.sol";
import {EscrowVault} from "../../src/EscrowVault.sol";
import {IEscrowVault} from "../../src/interfaces/IEscrowVault.sol";

/// @title EscrowVaultTest
/// @notice Comprehensive unit tests for EscrowVault.sol
contract EscrowVaultTest is BaseTest {
    bytes32 internal constant TRANSFER_ID_A = bytes32(uint256(0xAAAA));
    bytes32 internal constant TRANSFER_ID_B = bytes32(uint256(0xBBBB));

    // =========================================================================
    // lockFunds — happy paths
    // =========================================================================

    function test_LockFunds_UpdatesLockedBalance() public {
        uint256 amount = 100e6;
        qusd.mint(sender, amount);

        vm.prank(sender);
        qusd.approve(address(vault), amount);

        vm.prank(address(remit));
        vault.lockFunds(TRANSFER_ID_A, sender, amount);

        assertEq(vault.lockedBalance(TRANSFER_ID_A), amount);
    }

    function test_LockFunds_UpdatesTotalLocked() public {
        uint256 amount = 100e6;
        vm.prank(sender);
        qusd.approve(address(vault), amount);

        uint256 before = vault.totalLocked();

        vm.prank(address(remit));
        vault.lockFunds(TRANSFER_ID_A, sender, amount);

        assertEq(vault.totalLocked(), before + amount);
    }

    function test_LockFunds_TransfersQUSD() public {
        uint256 amount = 100e6;
        uint256 senderBefore = qusd.balanceOf(sender);
        uint256 vaultBefore = qusd.balanceOf(address(vault));

        vm.prank(sender);
        qusd.approve(address(vault), amount);

        vm.prank(address(remit));
        vault.lockFunds(TRANSFER_ID_A, sender, amount);

        assertEq(qusd.balanceOf(sender), senderBefore - amount);
        assertEq(qusd.balanceOf(address(vault)), vaultBefore + amount);
    }

    function test_LockFunds_EmitsEvent() public {
        uint256 amount = 100e6;
        vm.prank(sender);
        qusd.approve(address(vault), amount);

        vm.expectEmit(true, true, false, true);
        emit IEscrowVault.FundsLocked(TRANSFER_ID_A, sender, amount);

        vm.prank(address(remit));
        vault.lockFunds(TRANSFER_ID_A, sender, amount);
    }

    function test_LockFunds_TwoDistinctIds() public {
        uint256 amountA = 100e6;
        uint256 amountB = 200e6;

        vm.prank(sender);
        qusd.approve(address(vault), amountA + amountB);

        vm.startPrank(address(remit));
        vault.lockFunds(TRANSFER_ID_A, sender, amountA);
        vault.lockFunds(TRANSFER_ID_B, sender, amountB);
        vm.stopPrank();

        assertEq(vault.lockedBalance(TRANSFER_ID_A), amountA);
        assertEq(vault.lockedBalance(TRANSFER_ID_B), amountB);
        assertEq(vault.totalLocked(), amountA + amountB);
    }

    // =========================================================================
    // lockFunds — reverts
    // =========================================================================

    function test_RevertWhen_LockFunds_CallerNotRemitChain() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowVault.CallerNotRemitChain.selector, attacker));
        vm.prank(attacker);
        vault.lockFunds(TRANSFER_ID_A, sender, 100e6);
    }

    function test_RevertWhen_LockFunds_TransferIdCollision() public {
        uint256 amount = 100e6;
        vm.prank(sender);
        qusd.approve(address(vault), amount * 2);

        vm.prank(address(remit));
        vault.lockFunds(TRANSFER_ID_A, sender, amount);

        vm.expectRevert(abi.encodeWithSelector(IEscrowVault.TransferIdCollision.selector, TRANSFER_ID_A));
        vm.prank(address(remit));
        vault.lockFunds(TRANSFER_ID_A, sender, amount);
    }

    function test_RevertWhen_LockFunds_ZeroAmount() public {
        vm.expectRevert(IEscrowVault.ZeroAmount.selector);
        vm.prank(address(remit));
        vault.lockFunds(TRANSFER_ID_A, sender, 0);
    }

    function test_RevertWhen_LockFunds_WhenPaused() public {
        vm.prank(owner);
        vault.pause();

        vm.expectRevert();
        vm.prank(address(remit));
        vault.lockFunds(TRANSFER_ID_A, sender, 100e6);
    }

    // =========================================================================
    // releaseFunds — happy paths
    // =========================================================================

    function _lockForRelease(uint256 amount) internal {
        vm.prank(sender);
        qusd.approve(address(vault), amount);
        vm.prank(address(remit));
        vault.lockFunds(TRANSFER_ID_A, sender, amount);
    }

    function test_ReleaseFunds_TransfersNetToRecipient() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        uint256 recipientBefore = qusd.balanceOf(recipient);

        vm.prank(address(remit));
        vault.releaseFunds(TRANSFER_ID_A, recipient);

        uint256 fee = (amount * vault.feeBps()) / 10_000;
        assertEq(qusd.balanceOf(recipient), recipientBefore + amount - fee);
    }

    function test_ReleaseFunds_TransfersFeeToTreasury() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        uint256 treasuryBefore = qusd.balanceOf(feeTreasury);

        vm.prank(address(remit));
        vault.releaseFunds(TRANSFER_ID_A, recipient);

        uint256 expectedFee = (amount * vault.feeBps()) / 10_000; // 0.1% of 1000 QUSD = 1 QUSD
        assertEq(qusd.balanceOf(feeTreasury), treasuryBefore + expectedFee);
    }

    function test_ReleaseFunds_ZerosLockedBalance() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        vm.prank(address(remit));
        vault.releaseFunds(TRANSFER_ID_A, recipient);

        assertEq(vault.lockedBalance(TRANSFER_ID_A), 0);
    }

    function test_ReleaseFunds_DecreasesTotalLocked() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        uint256 before = vault.totalLocked();

        vm.prank(address(remit));
        vault.releaseFunds(TRANSFER_ID_A, recipient);

        assertEq(vault.totalLocked(), before - amount);
    }

    function test_ReleaseFunds_EmitsEvent() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        uint256 fee = (amount * vault.feeBps()) / 10_000;
        uint256 net = amount - fee;

        vm.expectEmit(true, true, false, true);
        emit IEscrowVault.FundsReleased(TRANSFER_ID_A, recipient, net, fee);

        vm.prank(address(remit));
        vault.releaseFunds(TRANSFER_ID_A, recipient);
    }

    function test_ReleaseFunds_ZeroFee_FullAmount() public {
        // Set fee to 0
        vm.prank(owner);
        vault.setFeeBps(0);

        uint256 amount = 1000e6;
        _lockForRelease(amount);

        uint256 recipientBefore = qusd.balanceOf(recipient);

        vm.prank(address(remit));
        vault.releaseFunds(TRANSFER_ID_A, recipient);

        assertEq(qusd.balanceOf(recipient), recipientBefore + amount);
        assertEq(qusd.balanceOf(feeTreasury), 0); // No fee transferred
    }

    // =========================================================================
    // releaseFunds — reverts
    // =========================================================================

    function test_RevertWhen_ReleaseFunds_TransferIdNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowVault.TransferIdNotFound.selector, TRANSFER_ID_A));
        vm.prank(address(remit));
        vault.releaseFunds(TRANSFER_ID_A, recipient);
    }

    function test_RevertWhen_ReleaseFunds_ZeroRecipient() public {
        uint256 amount = 100e6;
        _lockForRelease(amount);

        vm.expectRevert(IEscrowVault.ZeroAddress.selector);
        vm.prank(address(remit));
        vault.releaseFunds(TRANSFER_ID_A, address(0));
    }

    function test_RevertWhen_ReleaseFunds_WhenPaused() public {
        uint256 amount = 100e6;
        _lockForRelease(amount);

        vm.prank(owner);
        vault.pause();

        vm.expectRevert();
        vm.prank(address(remit));
        vault.releaseFunds(TRANSFER_ID_A, recipient);
    }

    function test_RevertWhen_ReleaseFunds_CallerNotRemitChain() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowVault.CallerNotRemitChain.selector, attacker));
        vm.prank(attacker);
        vault.releaseFunds(TRANSFER_ID_A, recipient);
    }

    // =========================================================================
    // refundFunds — happy paths
    // =========================================================================

    function test_RefundFunds_TransfersFullAmountBack() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        uint256 senderBefore = qusd.balanceOf(sender);

        vm.prank(address(remit));
        vault.refundFunds(TRANSFER_ID_A, sender);

        assertEq(qusd.balanceOf(sender), senderBefore + amount);
    }

    function test_RefundFunds_ZerosLockedBalance() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        vm.prank(address(remit));
        vault.refundFunds(TRANSFER_ID_A, sender);

        assertEq(vault.lockedBalance(TRANSFER_ID_A), 0);
    }

    function test_RefundFunds_DecreasesTotalLocked() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);
        uint256 before = vault.totalLocked();

        vm.prank(address(remit));
        vault.refundFunds(TRANSFER_ID_A, sender);

        assertEq(vault.totalLocked(), before - amount);
    }

    function test_RefundFunds_EmitsEvent() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        vm.expectEmit(true, true, false, true);
        emit IEscrowVault.FundsRefunded(TRANSFER_ID_A, sender, amount);

        vm.prank(address(remit));
        vault.refundFunds(TRANSFER_ID_A, sender);
    }

    /// @notice Key invariant: refundFunds MUST succeed even when vault is paused.
    function test_RefundFunds_SucceedsWhenPaused() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        vm.prank(owner);
        vault.pause();

        uint256 senderBefore = qusd.balanceOf(sender);

        // Must NOT revert even when paused
        vm.prank(address(remit));
        vault.refundFunds(TRANSFER_ID_A, sender);

        assertEq(qusd.balanceOf(sender), senderBefore + amount);
    }

    // =========================================================================
    // refundFunds — reverts
    // =========================================================================

    function test_RevertWhen_RefundFunds_TransferIdNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowVault.TransferIdNotFound.selector, TRANSFER_ID_A));
        vm.prank(address(remit));
        vault.refundFunds(TRANSFER_ID_A, sender);
    }

    function test_RevertWhen_RefundFunds_ZeroSender() public {
        uint256 amount = 100e6;
        _lockForRelease(amount);

        vm.expectRevert(IEscrowVault.ZeroAddress.selector);
        vm.prank(address(remit));
        vault.refundFunds(TRANSFER_ID_A, address(0));
    }

    // =========================================================================
    // Owner-gated — setFeeBps, setFeeTreasury
    // =========================================================================

    function test_SetFeeBps_Owner_Succeeds() public {
        vm.expectEmit(false, false, false, true);
        emit IEscrowVault.FeeBpsUpdated(DEFAULT_FEE_BPS, 50);

        vm.prank(owner);
        vault.setFeeBps(50);
        assertEq(vault.feeBps(), 50);
    }

    function test_RevertWhen_SetFeeBps_ExceedsMax() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IEscrowVault.FeeBpsExceedsMax.selector, uint16(101), uint16(100)));
        vault.setFeeBps(101);
    }

    function test_SetFeeBps_AtMax_Succeeds() public {
        vm.prank(owner);
        vault.setFeeBps(100); // exactly MAX_FEE_BPS
        assertEq(vault.feeBps(), 100);
    }

    function test_SetFeeTreasury_Owner_Succeeds() public {
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(true, true, false, false);
        emit IEscrowVault.FeeTreasuryUpdated(feeTreasury, newTreasury);

        vm.prank(owner);
        vault.setFeeTreasury(newTreasury);
        assertEq(vault.feeTreasury(), newTreasury);
    }

    function test_RevertWhen_SetFeeTreasury_ZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(IEscrowVault.ZeroAddress.selector);
        vault.setFeeTreasury(address(0));
    }

    function test_RevertWhen_SetFeeBps_NotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.setFeeBps(50);
    }

    function test_RevertWhen_SetFeeTreasury_NotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.setFeeTreasury(makeAddr("x"));
    }

    // =========================================================================
    // Solvency invariant check
    // =========================================================================

    function test_VaultSolvency_AfterLockRelease() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        assertTrue(qusd.balanceOf(address(vault)) >= vault.totalLocked());

        vm.prank(address(remit));
        vault.releaseFunds(TRANSFER_ID_A, recipient);

        assertTrue(qusd.balanceOf(address(vault)) >= vault.totalLocked());
    }

    function test_VaultSolvency_AfterLockRefund() public {
        uint256 amount = 1000e6;
        _lockForRelease(amount);

        assertTrue(qusd.balanceOf(address(vault)) >= vault.totalLocked());

        vm.prank(address(remit));
        vault.refundFunds(TRANSFER_ID_A, sender);

        assertTrue(qusd.balanceOf(address(vault)) >= vault.totalLocked());
    }

    // =========================================================================
    // Constructor validation
    // =========================================================================

    function test_RevertWhen_Constructor_ZeroQUSD() public {
        vm.expectRevert(IEscrowVault.ZeroAddress.selector);
        new EscrowVault(address(0), address(remit), feeTreasury, DEFAULT_FEE_BPS, owner);
    }

    function test_RevertWhen_Constructor_ZeroRemitChain() public {
        vm.expectRevert(IEscrowVault.ZeroAddress.selector);
        new EscrowVault(address(qusd), address(0), feeTreasury, DEFAULT_FEE_BPS, owner);
    }

    function test_RevertWhen_Constructor_ZeroTreasury() public {
        vm.expectRevert(IEscrowVault.ZeroAddress.selector);
        new EscrowVault(address(qusd), address(remit), address(0), DEFAULT_FEE_BPS, owner);
    }

    function test_RevertWhen_Constructor_FeeBpsExceedsMax() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrowVault.FeeBpsExceedsMax.selector, uint16(101), uint16(100)));
        new EscrowVault(address(qusd), address(remit), feeTreasury, 101, owner);
    }
}
