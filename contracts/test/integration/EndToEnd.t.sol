// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {MockQUSD} from "../helpers/MockQUSD.sol";
import {MaliciousReceiver} from "../helpers/MaliciousReceiver.sol";
import {KYCRegistry} from "../../src/KYCRegistry.sol";
import {EscrowVault} from "../../src/EscrowVault.sol";
import {RemitChain} from "../../src/RemitChain.sol";
import {IRemitChain} from "../../src/interfaces/IRemitChain.sol";
import {IEscrowVault} from "../../src/interfaces/IEscrowVault.sol";

/// @title EndToEnd
/// @notice Integration tests covering complete user flows and adversarial scenarios.
contract EndToEnd is Test {
    MockQUSD internal qusd;
    MaliciousReceiver internal malicious;
    KYCRegistry internal kyc;
    EscrowVault internal vault;
    RemitChain internal remit;

    address internal owner;
    address internal passOracle;
    uint256 internal passOraclePk;
    address internal sender;
    uint256 internal senderPk;
    address internal recipient;
    uint256 internal recipientPk;
    address internal relayer;
    address internal attacker;
    uint256 internal attackerPk;
    address internal feeTreasury;

    bytes32 internal constant SALT = bytes32(uint256(0xDEADBEEF));
    uint256 internal constant SEND_AMOUNT = 1000e6;

    function setUp() public {
        (owner,) = makeAddrAndKey("owner");
        (passOracle, passOraclePk) = makeAddrAndKey("passOracle");
        (sender, senderPk) = makeAddrAndKey("sender");
        (recipient, recipientPk) = makeAddrAndKey("recipient");
        (attacker, attackerPk) = makeAddrAndKey("attacker");
        relayer = makeAddr("relayer");
        feeTreasury = makeAddr("feeTreasury");

        qusd = new MockQUSD();
        malicious = new MaliciousReceiver();

        uint256 nonceBefore = vm.getNonce(address(this));
        address predictedKYC = vm.computeCreateAddress(address(this), nonceBefore);
        address predictedVault = vm.computeCreateAddress(address(this), nonceBefore + 1);
        address predictedRemit = vm.computeCreateAddress(address(this), nonceBefore + 2);

        kyc = new KYCRegistry(passOracle, predictedRemit, owner);
        vault = new EscrowVault(address(qusd), predictedRemit, feeTreasury, 10, owner);
        remit = new RemitChain(predictedKYC, predictedVault, address(qusd), owner);

        require(address(kyc) == predictedKYC);
        require(address(vault) == predictedVault);
        require(address(remit) == predictedRemit);

        qusd.mint(sender, 100_000e6);
        qusd.mint(attacker, 100_000e6);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _kycUser(address user, uint8 level) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("VerifyUser(address user,uint8 newLevel,uint256 deadline,uint256 nonce)"),
                user,
                level,
                deadline,
                kyc.nonces(user)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", kyc.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(passOraclePk, digest);
        kyc.verifyUser(user, level, deadline, abi.encodePacked(r, s, v));
    }

    function _sendRemittance(address _sender, uint256 amount, bytes32 otpReveal, address _recipient)
        internal
        returns (bytes32 transferId)
    {
        uint256 nonce = remit.senderNonces(_sender);
        bytes32 predictedId = keccak256(abi.encode(_sender, nonce, block.chainid, address(remit)));
        bytes32 otpCommitHash = keccak256(abi.encode(otpReveal, predictedId, _recipient));
        bytes32 phoneHash = keccak256(abi.encodePacked(SALT, "+919876543210"));

        vm.startPrank(_sender);
        qusd.approve(address(vault), amount);
        transferId = remit.sendRemittance(phoneHash, amount, otpCommitHash, 1);
        vm.stopPrank();
    }

    function _claimRemittance(bytes32 transferId, bytes32 otpReveal, address _recipient, uint256 _recipientPk)
        internal
    {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = remit.recipientNonces(_recipient);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ClaimRemittance(bytes32 transferId,address recipient,uint256 deadline,uint256 nonce)"),
                transferId,
                _recipient,
                deadline,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", remit.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_recipientPk, digest);
        vm.prank(relayer);
        remit.claimRemittance(transferId, otpReveal, _recipient, deadline, abi.encodePacked(r, s, v));
    }

    // =========================================================================
    // Integration test 1: Full happy path
    // =========================================================================

    function test_FullFlow_SendToClaim() public {
        _kycUser(sender, 2); // Tier 2: 5000 QUSD/day limit

        uint256 senderBefore = qusd.balanceOf(sender);
        uint256 recipientBefore = qusd.balanceOf(recipient);
        uint256 treasuryBefore = qusd.balanceOf(feeTreasury);

        bytes32 otpReveal = bytes32(uint256(123456));
        bytes32 transferId = _sendRemittance(sender, SEND_AMOUNT, otpReveal, recipient);

        assertEq(uint8(remit.getTransferStatus(transferId)), uint8(IRemitChain.Status.PENDING));
        assertEq(vault.lockedBalance(transferId), SEND_AMOUNT);
        assertEq(qusd.balanceOf(sender), senderBefore - SEND_AMOUNT);

        _claimRemittance(transferId, otpReveal, recipient, recipientPk);

        assertEq(uint8(remit.getTransferStatus(transferId)), uint8(IRemitChain.Status.CLAIMED));
        assertEq(vault.lockedBalance(transferId), 0);

        uint256 fee = (SEND_AMOUNT * vault.feeBps()) / 10_000;
        assertEq(qusd.balanceOf(recipient), recipientBefore + SEND_AMOUNT - fee);
        assertEq(qusd.balanceOf(feeTreasury), treasuryBefore + fee);
        assertGe(qusd.balanceOf(address(vault)), vault.totalLocked());
    }

    // =========================================================================
    // Integration test 2: Pause mid-transfer — refund still works
    // =========================================================================

    function test_PauseMidTransfer_RefundSucceeds() public {
        _kycUser(sender, 2);

        bytes32 otpReveal = bytes32(uint256(999999));
        bytes32 transferId = _sendRemittance(sender, SEND_AMOUNT, otpReveal, recipient);

        vm.prank(owner);
        vault.pause();
        vm.prank(owner);
        remit.pause();

        vm.warp(block.timestamp + remit.CLAIM_WINDOW() + 1);

        uint256 senderBefore = qusd.balanceOf(sender);

        // cancelRemittance MUST work even when both contracts are paused
        vm.prank(sender);
        remit.cancelRemittance(transferId);

        assertEq(uint8(remit.getTransferStatus(transferId)), uint8(IRemitChain.Status.CANCELLED));
        assertEq(qusd.balanceOf(sender), senderBefore + SEND_AMOUNT);
        assertGe(qusd.balanceOf(address(vault)), vault.totalLocked());
    }

    // =========================================================================
    // Integration test 3: Expired transfer cannot be claimed
    // =========================================================================

    function test_ExpiredTransfer_CannotBeClaimed() public {
        _kycUser(sender, 2);

        bytes32 otpReveal = bytes32(uint256(999999));
        bytes32 transferId = _sendRemittance(sender, SEND_AMOUNT, otpReveal, recipient);

        RemitChain.Transfer memory t = remit.getTransfer(transferId);
        vm.warp(t.expiry); // exactly at expiry boundary — strict < means this should fail

        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = remit.recipientNonces(recipient);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ClaimRemittance(bytes32 transferId,address recipient,uint256 deadline,uint256 nonce)"),
                transferId,
                recipient,
                deadline,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", remit.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(recipientPk, digest);

        vm.expectRevert(abi.encodeWithSelector(IRemitChain.TransferExpired.selector, transferId, t.expiry));
        vm.prank(relayer);
        remit.claimRemittance(transferId, otpReveal, recipient, deadline, abi.encodePacked(r, s, v));
    }

    // =========================================================================
    // Integration test 4: Two senders — unique transferIds
    // =========================================================================

    function test_DualSender_UniqueTransferIds() public {
        _kycUser(sender, 2);

        (address sender2,) = makeAddrAndKey("sender2");
        _kycUser(sender2, 2);
        qusd.mint(sender2, SEND_AMOUNT * 2);

        bytes32 otp1 = bytes32(uint256(111111));
        bytes32 otp2 = bytes32(uint256(222222));

        bytes32 id1 = _sendRemittance(sender, SEND_AMOUNT, otp1, recipient);

        vm.startPrank(sender2);
        uint256 n2 = remit.senderNonces(sender2);
        bytes32 predictedId2 = keccak256(abi.encode(sender2, n2, block.chainid, address(remit)));
        bytes32 c2 = keccak256(abi.encode(otp2, predictedId2, recipient));
        qusd.approve(address(vault), SEND_AMOUNT);
        bytes32 id2 = remit.sendRemittance(bytes32(0), SEND_AMOUNT, c2, 1);
        vm.stopPrank();

        assertTrue(id1 != id2, "TransferIds must be unique across senders");
        assertEq(vault.totalLocked(), SEND_AMOUNT * 2);
    }

    // =========================================================================
    // Integration test 5: Relayer redirect attempt
    // =========================================================================

    function test_RelayerRedirect_Reverts() public {
        _kycUser(sender, 2);

        bytes32 otpReveal = bytes32(uint256(999999));
        bytes32 transferId = _sendRemittance(sender, SEND_AMOUNT, otpReveal, recipient);

        address fakeRecipient = attacker;
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = remit.recipientNonces(fakeRecipient);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ClaimRemittance(bytes32 transferId,address recipient,uint256 deadline,uint256 nonce)"),
                transferId,
                fakeRecipient,
                deadline,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", remit.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPk, digest);

        // OTP commit was computed with real `recipient` — attacker's address won't match
        vm.expectRevert(abi.encodeWithSelector(IRemitChain.InvalidOTPReveal.selector, transferId));
        vm.prank(attacker);
        remit.claimRemittance(transferId, otpReveal, fakeRecipient, deadline, abi.encodePacked(r, s, v));

        assertEq(uint8(remit.getTransferStatus(transferId)), uint8(IRemitChain.Status.PENDING));
        assertEq(vault.lockedBalance(transferId), SEND_AMOUNT);
    }

    // =========================================================================
    // Integration test 6: Access control on vault
    // =========================================================================

    function test_Reentrancy_Cancel_Reverts() public {
        bytes32 fakeTid = keccak256("malicious_tid");
        vm.expectRevert(abi.encodeWithSelector(IEscrowVault.CallerNotRemitChain.selector, address(this)));
        vault.refundFunds(fakeTid, address(malicious));
    }

    // =========================================================================
    // Integration test 7: Multiple sends, partial claims
    // =========================================================================

    function test_MultipleSends_PartialClaims_SolvencyHolds() public {
        _kycUser(sender, 2);

        bytes32[] memory ids = new bytes32[](3);
        bytes32[] memory otps = new bytes32[](3);

        for (uint256 i = 0; i < 3; i++) {
            otps[i] = bytes32(uint256(i + 1) * 111111);
            ids[i] = _sendRemittance(sender, 500e6, otps[i], recipient);
        }

        assertEq(vault.totalLocked(), 1500e6);
        assertGe(qusd.balanceOf(address(vault)), vault.totalLocked());

        _claimRemittance(ids[0], otps[0], recipient, recipientPk);

        vm.prank(sender);
        remit.cancelRemittance(ids[1]);

        assertGe(qusd.balanceOf(address(vault)), vault.totalLocked());
        assertEq(vault.totalLocked(), 500e6);
    }
}
