// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "../helpers/BaseTest.sol";
import {RemitChain} from "../../src/RemitChain.sol";
import {IRemitChain} from "../../src/interfaces/IRemitChain.sol";
import {IKYCRegistry} from "../../src/interfaces/IKYCRegistry.sol";

/// @title RemitChainTest
/// @notice Comprehensive unit tests for RemitChain.sol
contract RemitChainTest is BaseTest {
    uint256 internal constant SEND_AMOUNT = 100e6;

    function setUp() public override {
        super.setUp();
        _setupKYC(sender, 1);
    }

    // =========================================================================
    // sendRemittance — happy paths
    // =========================================================================

    function test_SendRemittance_ReturnsTransferId() public {
        bytes32 recipientPhoneHash = keccak256(abi.encodePacked(SALT, "+919876543210"));

        // Predict the transferId
        uint256 nonce = remit.senderNonces(sender);
        bytes32 expectedId = keccak256(abi.encode(sender, nonce, block.chainid, address(remit)));

        bytes32 otpReveal = bytes32(uint256(123456));
        bytes32 otpCommitHash = keccak256(abi.encode(otpReveal, expectedId, recipient));

        vm.startPrank(sender);
        qusd.approve(address(vault), SEND_AMOUNT);
        bytes32 transferId = remit.sendRemittance(recipientPhoneHash, SEND_AMOUNT, otpCommitHash, 1);
        vm.stopPrank();

        assertEq(transferId, expectedId);
    }

    function test_SendRemittance_StoresPendingTransfer() public {
        (bytes32 transferId,) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(123456)), recipient);
        IRemitChain.Status status = remit.getTransferStatus(transferId);
        assertEq(uint8(status), uint8(IRemitChain.Status.PENDING));
    }

    function test_SendRemittance_LocksQUSD() public {
        uint256 senderBefore = qusd.balanceOf(sender);
        uint256 vaultBefore = qusd.balanceOf(address(vault));

        (bytes32 transferId,) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(123456)), recipient);

        assertEq(qusd.balanceOf(sender), senderBefore - SEND_AMOUNT);
        assertEq(qusd.balanceOf(address(vault)), vaultBefore + SEND_AMOUNT);
        assertEq(vault.lockedBalance(transferId), SEND_AMOUNT);
    }

    function test_SendRemittance_EmitsEvent() public {
        uint256 nonce = remit.senderNonces(sender);
        bytes32 expectedId = keccak256(abi.encode(sender, nonce, block.chainid, address(remit)));
        bytes32 recipientPhoneHash = keccak256(abi.encodePacked(SALT, "+919876543210"));
        bytes32 otpReveal = bytes32(uint256(123456));
        bytes32 otpCommitHash = keccak256(abi.encode(otpReveal, expectedId, recipient));
        uint64 expectedExpiry = uint64(block.timestamp + remit.CLAIM_WINDOW());

        // Pre-approve so approve() Approval event doesn't interfere with expectEmit
        vm.prank(sender);
        qusd.approve(address(vault), SEND_AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit IRemitChain.TransferInitiated(expectedId, sender, recipientPhoneHash, SEND_AMOUNT, expectedExpiry, 1);
        vm.prank(sender);
        remit.sendRemittance(recipientPhoneHash, SEND_AMOUNT, otpCommitHash, 1);
    }

    function test_SendRemittance_IncrementsNonce() public {
        assertEq(remit.senderNonces(sender), 0);
        _doSend(sender, SEND_AMOUNT, bytes32(uint256(1)), recipient);
        assertEq(remit.senderNonces(sender), 1);
        _doSend(sender, SEND_AMOUNT, bytes32(uint256(2)), recipient);
        assertEq(remit.senderNonces(sender), 2);
    }

    function test_SendRemittance_TwoSends_UniqueIds() public {
        (bytes32 id1,) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(1)), recipient);
        (bytes32 id2,) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(2)), recipient);
        assertTrue(id1 != id2);
    }

    // =========================================================================
    // sendRemittance — reverts
    // =========================================================================

    function test_RevertWhen_Send_BelowMinAmount() public {
        uint256 belowMin = remit.MIN_AMOUNT() - 1;
        // Pre-approve so approve() doesn't consume expectRevert
        vm.prank(sender);
        qusd.approve(address(vault), belowMin);

        vm.expectRevert(abi.encodeWithSelector(IRemitChain.AmountBelowMinimum.selector, belowMin, remit.MIN_AMOUNT()));
        vm.prank(sender);
        remit.sendRemittance(bytes32(0), belowMin, bytes32(0), 1);
    }

    function test_RevertWhen_Send_AtExactMinAmount_Succeeds() public {
        uint256 minAmount = remit.MIN_AMOUNT();
        qusd.mint(sender, minAmount);

        vm.startPrank(sender);
        qusd.approve(address(vault), minAmount);
        // Should not revert
        remit.sendRemittance(bytes32(0), minAmount, bytes32(0), 1);
        vm.stopPrank();
    }

    function test_RevertWhen_Send_KYCInsufficient() public {
        // attacker has no KYC, defaults to Tier 1 limit (500e6)
        uint256 limit = kyc.DEFAULT_T1_LIMIT();
        uint256 exceedAmount = limit + 1e6;
        qusd.mint(attacker, exceedAmount);

        // pre-approve to isolate the revert to sendRemittance
        vm.prank(attacker);
        qusd.approve(address(vault), exceedAmount);

        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.DailyLimitExceeded.selector, attacker, limit, exceedAmount));
        vm.prank(attacker);
        remit.sendRemittance(bytes32(0), exceedAmount, bytes32(0), 1);
    }

    function test_RevertWhen_Send_WhenPaused() public {
        vm.prank(owner);
        remit.pause();

        // Pre-approve to isolate the revert to sendRemittance
        vm.prank(sender);
        qusd.approve(address(vault), SEND_AMOUNT);

        vm.expectRevert();
        vm.prank(sender);
        remit.sendRemittance(bytes32(0), SEND_AMOUNT, bytes32(0), 1);
    }

    // =========================================================================
    // claimRemittance — happy paths
    // =========================================================================

    function test_ClaimRemittance_Happy() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);

        uint256 recipientBefore = qusd.balanceOf(recipient);

        _doClaim(transferId, otpReveal, recipient, recipientPk);

        assertEq(uint8(remit.getTransferStatus(transferId)), uint8(IRemitChain.Status.CLAIMED));
        assertTrue(qusd.balanceOf(recipient) > recipientBefore); // received net amount
    }

    function test_ClaimRemittance_EmitsEvent() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);

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

        vm.expectEmit(true, true, false, false);
        emit IRemitChain.TransferClaimed(transferId, recipient);

        vm.prank(relayer);
        remit.claimRemittance(transferId, otpReveal, recipient, deadline, abi.encodePacked(r, s, v));
    }

    function test_ClaimRemittance_IncrementsRecipientNonce() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);

        assertEq(remit.recipientNonces(recipient), 0);
        _doClaim(transferId, otpReveal, recipient, recipientPk);
        assertEq(remit.recipientNonces(recipient), 1);
    }

    // =========================================================================
    // claimRemittance — reverts
    // =========================================================================

    function test_RevertWhen_Claim_TransferNotFound() public {
        bytes32 fakeId = keccak256("fake");
        vm.expectRevert(abi.encodeWithSelector(IRemitChain.TransferNotFound.selector, fakeId));
        vm.prank(relayer);
        remit.claimRemittance(fakeId, bytes32(0), recipient, block.timestamp + 1, "");
    }

    function test_RevertWhen_Claim_WrongOTP() public {
        (bytes32 transferId,) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);

        bytes32 wrongOtp = bytes32(uint256(111111));
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

        vm.expectRevert(abi.encodeWithSelector(IRemitChain.InvalidOTPReveal.selector, transferId));
        vm.prank(relayer);
        remit.claimRemittance(transferId, wrongOtp, recipient, deadline, abi.encodePacked(r, s, v));
    }

    function test_RevertWhen_Claim_Expired() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);

        // Warp past expiry (48 hours + 1 second)
        vm.warp(block.timestamp + remit.CLAIM_WINDOW() + 1);

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

        RemitChain.Transfer memory t = remit.getTransfer(transferId);
        vm.expectRevert(abi.encodeWithSelector(IRemitChain.TransferExpired.selector, transferId, t.expiry));
        vm.prank(relayer);
        remit.claimRemittance(transferId, otpReveal, recipient, deadline, abi.encodePacked(r, s, v));
    }

    function test_RevertWhen_Claim_AtExactExpiry_Reverts() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);

        RemitChain.Transfer memory t = remit.getTransfer(transferId);

        // Warp to exact expiry — should fail (strictly <)
        vm.warp(t.expiry);

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

    function test_RevertWhen_Claim_BadRecipientSig_WrongKey() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);

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
        // Sign with WRONG key (attacker)
        (, uint256 attackerPk_) = makeAddrAndKey("attacker2");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPk_, digest);

        vm.expectRevert(IRemitChain.InvalidRecipientSignature.selector);
        vm.prank(relayer);
        remit.claimRemittance(transferId, otpReveal, recipient, deadline, abi.encodePacked(r, s, v));
    }

    function test_RevertWhen_Claim_AlreadyClaimed() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);
        _doClaim(transferId, otpReveal, recipient, recipientPk);

        // Build a fresh sig with updated nonce (nonce=1 after first claim)
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = remit.recipientNonces(recipient); // nonce=1
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
        bytes memory sig = abi.encodePacked(r, s, v);

        // expectRevert immediately before the call that should revert
        vm.expectRevert(
            abi.encodeWithSelector(IRemitChain.TransferNotPending.selector, transferId, IRemitChain.Status.CLAIMED)
        );
        vm.prank(relayer);
        remit.claimRemittance(transferId, otpReveal, recipient, deadline, sig);
    }

    function test_RevertWhen_Claim_SigExpired() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);

        uint256 deadline = block.timestamp - 1; // expired signature deadline
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

        vm.expectRevert(abi.encodeWithSelector(IRemitChain.SignatureExpired.selector, deadline, block.timestamp));
        vm.prank(relayer);
        remit.claimRemittance(transferId, otpReveal, recipient, deadline, abi.encodePacked(r, s, v));
    }

    function test_RevertWhen_Claim_WhenPaused() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);

        vm.prank(owner);
        remit.pause();

        vm.expectRevert();
        vm.prank(relayer);
        remit.claimRemittance(transferId, otpReveal, recipient, block.timestamp + 1, "");
    }

    function test_RevertWhen_Claim_RelayerRedirectsToWrongRecipient() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);

        address wrongRecipient = makeAddr("wrongRecipient");

        // Relayer tries to claim with wrong recipient — OTP commit check should fail
        // because otpCommitHash was computed with the REAL recipient
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("ClaimRemittance(bytes32 transferId,address recipient,uint256 deadline,uint256 nonce)"),
                transferId,
                wrongRecipient,
                deadline,
                remit.recipientNonces(wrongRecipient)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", remit.domainSeparator(), structHash));
        // Even if attacker controls wrongRecipient's key
        (address wrongAddr, uint256 wrongPk) = makeAddrAndKey("wrongRecipient");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);

        vm.expectRevert(abi.encodeWithSelector(IRemitChain.InvalidOTPReveal.selector, transferId));
        vm.prank(relayer);
        remit.claimRemittance(transferId, otpReveal, wrongAddr, deadline, abi.encodePacked(r, s, v));
    }

    // =========================================================================
    // cancelRemittance — happy paths
    // =========================================================================

    function test_Cancel_BySender_BeforeExpiry() public {
        (bytes32 transferId,) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(1)), recipient);

        uint256 senderBefore = qusd.balanceOf(sender);

        vm.expectEmit(true, true, false, false);
        emit IRemitChain.TransferCancelled(transferId, sender);

        vm.prank(sender);
        remit.cancelRemittance(transferId);

        assertEq(uint8(remit.getTransferStatus(transferId)), uint8(IRemitChain.Status.CANCELLED));
        assertEq(qusd.balanceOf(sender), senderBefore + SEND_AMOUNT); // full refund
    }

    function test_Cancel_ByAnyone_AfterExpiry() public {
        (bytes32 transferId,) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(1)), recipient);

        vm.warp(block.timestamp + remit.CLAIM_WINDOW() + 1);

        uint256 senderBefore = qusd.balanceOf(sender);

        vm.prank(attacker); // anyone can cancel after expiry
        remit.cancelRemittance(transferId);

        assertEq(uint8(remit.getTransferStatus(transferId)), uint8(IRemitChain.Status.CANCELLED));
        assertEq(qusd.balanceOf(sender), senderBefore + SEND_AMOUNT); // still refunds to sender
    }

    function test_Cancel_Succeeds_WhenPaused() public {
        (bytes32 transferId,) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(1)), recipient);

        vm.prank(owner);
        remit.pause();

        uint256 senderBefore = qusd.balanceOf(sender);

        // Cancel must succeed even when paused
        vm.prank(sender);
        remit.cancelRemittance(transferId);

        assertEq(uint8(remit.getTransferStatus(transferId)), uint8(IRemitChain.Status.CANCELLED));
        assertEq(qusd.balanceOf(sender), senderBefore + SEND_AMOUNT);
    }

    // =========================================================================
    // cancelRemittance — reverts
    // =========================================================================

    function test_RevertWhen_Cancel_NotSender_BeforeExpiry() public {
        (bytes32 transferId,) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(1)), recipient);

        vm.expectRevert(abi.encodeWithSelector(IRemitChain.UnauthorizedCancel.selector, attacker, sender));
        vm.prank(attacker);
        remit.cancelRemittance(transferId);
    }

    function test_RevertWhen_Cancel_AlreadyClaimed() public {
        (bytes32 transferId, bytes32 otpReveal) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(999999)), recipient);
        _doClaim(transferId, otpReveal, recipient, recipientPk);

        vm.expectRevert(
            abi.encodeWithSelector(IRemitChain.TransferNotPending.selector, transferId, IRemitChain.Status.CLAIMED)
        );
        vm.prank(sender);
        remit.cancelRemittance(transferId);
    }

    function test_RevertWhen_Cancel_AlreadyCancelled() public {
        (bytes32 transferId,) = _doSend(sender, SEND_AMOUNT, bytes32(uint256(1)), recipient);

        vm.prank(sender);
        remit.cancelRemittance(transferId);

        vm.expectRevert(
            abi.encodeWithSelector(IRemitChain.TransferNotPending.selector, transferId, IRemitChain.Status.CANCELLED)
        );
        vm.prank(sender);
        remit.cancelRemittance(transferId);
    }

    function test_RevertWhen_Cancel_TransferNotFound() public {
        bytes32 fakeId = keccak256("nonexistent");
        vm.expectRevert(abi.encodeWithSelector(IRemitChain.TransferNotFound.selector, fakeId));
        vm.prank(sender);
        remit.cancelRemittance(fakeId);
    }

    // =========================================================================
    // Status machine — invalid transitions
    // =========================================================================

    function test_StatusMachine_NoneToClaimedReverts() public {
        bytes32 fakeId = keccak256("never_created");
        vm.expectRevert(abi.encodeWithSelector(IRemitChain.TransferNotFound.selector, fakeId));
        vm.prank(relayer);
        remit.claimRemittance(fakeId, bytes32(0), recipient, block.timestamp + 1, "");
    }

    // =========================================================================
    // Permit variant
    // =========================================================================

    function test_SendRemittanceWithPermit_SingleTx() public {
        uint256 amount = SEND_AMOUNT;
        uint256 nonce = remit.senderNonces(sender);
        bytes32 predictedId = keccak256(abi.encode(sender, nonce, block.chainid, address(remit)));
        bytes32 otpReveal = bytes32(uint256(777777));
        bytes32 otpCommitHash = keccak256(abi.encode(otpReveal, predictedId, recipient));
        bytes32 phoneHash = keccak256(abi.encodePacked(SALT, "+919876543210"));

        // Build EIP-2612 permit signature
        uint256 permitDeadline = block.timestamp + 1 hours;
        bytes32 permitHash = keccak256(
            abi.encodePacked(
                "\x19\x01",
                qusd.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        sender,
                        address(vault),
                        amount,
                        qusd.nonces(sender),
                        permitDeadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(senderPk, permitHash);

        // No prior approval needed — permit handles it
        vm.prank(sender);
        bytes32 transferId =
            remit.sendRemittanceWithPermit(phoneHash, amount, otpCommitHash, 1, permitDeadline, v, r, s);

        assertEq(transferId, predictedId);
        assertEq(uint8(remit.getTransferStatus(transferId)), uint8(IRemitChain.Status.PENDING));
        assertEq(vault.lockedBalance(transferId), amount);
    }
}
