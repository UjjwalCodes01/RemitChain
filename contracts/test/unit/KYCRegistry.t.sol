// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "../helpers/BaseTest.sol";
import {KYCRegistry} from "../../src/KYCRegistry.sol";
import {IKYCRegistry} from "../../src/interfaces/IKYCRegistry.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title KYCRegistryTest
/// @notice Comprehensive unit tests for KYCRegistry.sol
contract KYCRegistryTest is BaseTest {
    // =========================================================================
    // verifyUser — happy paths
    // =========================================================================

    function test_VerifyUser_Tier1_SetsLevel() public {
        _setupKYC(sender, 1);
        assertEq(kyc.getKYCLevel(sender), 1);
    }

    function test_VerifyUser_Tier2_SetsLevel() public {
        _setupKYC(sender, 2);
        assertEq(kyc.getKYCLevel(sender), 2);
    }

    function test_VerifyUser_EmitsEvent() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("VerifyUser(address user,uint8 newLevel,uint256 deadline,uint256 nonce)"),
                sender,
                uint8(1),
                deadline,
                kyc.nonces(sender)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", kyc.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(passOraclePk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectEmit(true, false, false, true);
        emit IKYCRegistry.UserVerified(sender, 1);
        kyc.verifyUser(sender, 1, deadline, sig);
    }

    function test_VerifyUser_IncrementsNonce() public {
        assertEq(kyc.nonces(sender), 0);
        _setupKYC(sender, 1);
        assertEq(kyc.nonces(sender), 1);
        _setupKYC(sender, 2);
        assertEq(kyc.nonces(sender), 2);
    }

    function test_VerifyUser_CanUpgradeTier() public {
        _setupKYC(sender, 1);
        assertEq(kyc.getKYCLevel(sender), 1);
        _setupKYC(sender, 2);
        assertEq(kyc.getKYCLevel(sender), 2);
    }

    // =========================================================================
    // verifyUser — reverts
    // =========================================================================

    function test_RevertWhen_VerifyUser_SignatureExpired() public {
        uint256 deadline = block.timestamp - 1; // already expired
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("VerifyUser(address user,uint8 newLevel,uint256 deadline,uint256 nonce)"),
                sender,
                uint8(1),
                deadline,
                kyc.nonces(sender)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", kyc.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(passOraclePk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.SignatureExpired.selector, deadline, block.timestamp));
        kyc.verifyUser(sender, 1, deadline, sig);
    }

    function test_RevertWhen_VerifyUser_InvalidSigner() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("VerifyUser(address user,uint8 newLevel,uint256 deadline,uint256 nonce)"),
                sender,
                uint8(1),
                deadline,
                kyc.nonces(sender)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", kyc.domainSeparator(), structHash));
        // Sign with WRONG key (attacker's key, not passOracle)
        (, uint256 attackerPk) = makeAddrAndKey("attacker_key");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(IKYCRegistry.InvalidSignature.selector);
        kyc.verifyUser(sender, 1, deadline, sig);
    }

    function test_RevertWhen_VerifyUser_ReplayedNonce() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("VerifyUser(address user,uint8 newLevel,uint256 deadline,uint256 nonce)"),
                sender,
                uint8(1),
                deadline,
                kyc.nonces(sender) // nonce = 0
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", kyc.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(passOraclePk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        // First use — succeeds
        kyc.verifyUser(sender, 1, deadline, sig);

        // Second use of same sig — nonce mismatch, signature no longer valid
        vm.expectRevert(IKYCRegistry.InvalidSignature.selector);
        kyc.verifyUser(sender, 1, deadline, sig);
    }

    function test_RevertWhen_VerifyUser_InvalidLevel_Zero() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("VerifyUser(address user,uint8 newLevel,uint256 deadline,uint256 nonce)"),
                sender,
                uint8(0),
                deadline,
                kyc.nonces(sender)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", kyc.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(passOraclePk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.InvalidLevel.selector, uint8(0)));
        kyc.verifyUser(sender, 0, deadline, sig);
    }

    function test_RevertWhen_VerifyUser_InvalidLevel_Three() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("VerifyUser(address user,uint8 newLevel,uint256 deadline,uint256 nonce)"),
                sender,
                uint8(3),
                deadline,
                kyc.nonces(sender)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", kyc.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(passOraclePk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.InvalidLevel.selector, uint8(3)));
        kyc.verifyUser(sender, 3, deadline, sig);
    }

    function test_RevertWhen_VerifyUser_ZeroAddress() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("VerifyUser(address user,uint8 newLevel,uint256 deadline,uint256 nonce)"),
                address(0),
                uint8(1),
                deadline,
                kyc.nonces(address(0))
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", kyc.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(passOraclePk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(IKYCRegistry.ZeroAddress.selector);
        kyc.verifyUser(address(0), 1, deadline, sig);
    }

    function test_RevertWhen_VerifyUser_WhenPaused() public {
        vm.prank(owner);
        kyc.pause();

        uint256 deadline = block.timestamp + 1 hours;
        vm.expectRevert();
        kyc.verifyUser(sender, 1, deadline, "");
    }

    // =========================================================================
    // checkAndConsume — happy paths
    // =========================================================================

    function test_CheckAndConsume_RecordsUsage() public {
        _setupKYC(sender, 1);
        uint256 amount = 100e6;

        vm.prank(address(remit));
        kyc.checkAndConsume(sender, amount);

        assertEq(kyc.getDailyUsage(sender), amount);
    }

    function test_CheckAndConsume_ExactLimit_Succeeds() public {
        _setupKYC(sender, 1);
        uint256 limit = kyc.getDailyLimit(sender); // 500e6

        vm.prank(address(remit));
        kyc.checkAndConsume(sender, limit);

        assertEq(kyc.getDailyUsage(sender), limit);
    }

    function test_CheckAndConsume_MultipleCallsAccumulate() public {
        _setupKYC(sender, 1);

        vm.startPrank(address(remit));
        kyc.checkAndConsume(sender, 100e6);
        kyc.checkAndConsume(sender, 200e6);
        vm.stopPrank();

        assertEq(kyc.getDailyUsage(sender), 300e6);
    }

    function test_CheckAndConsume_DailyReset_AtMidnight() public {
        _setupKYC(sender, 1);

        vm.prank(address(remit));
        kyc.checkAndConsume(sender, 400e6);
        assertEq(kyc.getDailyUsage(sender), 400e6);

        // Warp to next day
        vm.warp(block.timestamp + 1 days);

        // Usage resets automatically — new dayId means zero usage
        assertEq(kyc.getDailyUsage(sender), 0);

        // Should succeed again
        vm.prank(address(remit));
        kyc.checkAndConsume(sender, 400e6);
        assertEq(kyc.getDailyUsage(sender), 400e6);
    }

    function test_CheckAndConsume_Tier2_HigherLimit() public {
        _setupKYC(sender, 2);
        uint256 limit = kyc.getDailyLimit(sender); // 5000e6
        assertEq(limit, kyc.DEFAULT_T2_LIMIT());

        vm.prank(address(remit));
        kyc.checkAndConsume(sender, limit);
        assertEq(kyc.getDailyUsage(sender), limit);
    }

    // =========================================================================
    // checkAndConsume — reverts
    // =========================================================================

    function test_RevertWhen_CheckAndConsume_CallerNotRemitChain() public {
        _setupKYC(sender, 1);

        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.CallerNotRemitChain.selector, attacker));
        vm.prank(attacker);
        kyc.checkAndConsume(sender, 100e6);
    }

    function test_RevertWhen_CheckAndConsume_NoKYC() public {
        // sender has no KYC
        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.InsufficientKYC.selector, sender, uint8(1), uint8(0)));
        vm.prank(address(remit));
        kyc.checkAndConsume(sender, 100e6);
    }

    function test_RevertWhen_CheckAndConsume_ExceedsLimit_Exactly() public {
        _setupKYC(sender, 1);
        uint256 limit = kyc.getDailyLimit(sender); // 500e6

        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.DailyLimitExceeded.selector, sender, limit, limit + 1));
        vm.prank(address(remit));
        kyc.checkAndConsume(sender, limit + 1);
    }

    function test_RevertWhen_CheckAndConsume_AccumulatedExceedsLimit() public {
        _setupKYC(sender, 1);
        uint256 limit = kyc.getDailyLimit(sender);

        vm.prank(address(remit));
        kyc.checkAndConsume(sender, limit - 1e6); // Used: limit - 1e6

        // Trying to consume 2e6 more → would-be total = limit + 1e6 which exceeds limit
        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.DailyLimitExceeded.selector, sender, limit, limit + 1e6));
        vm.prank(address(remit));
        kyc.checkAndConsume(sender, 2e6);
    }

    // =========================================================================
    // getDailyLimit — tiers
    // =========================================================================

    function test_GetDailyLimit_Tier0_ReturnsZero() public view {
        assertEq(kyc.getDailyLimit(sender), 0);
    }

    function test_GetDailyLimit_Tier1() public {
        _setupKYC(sender, 1);
        assertEq(kyc.getDailyLimit(sender), kyc.DEFAULT_T1_LIMIT());
    }

    function test_GetDailyLimit_Tier2() public {
        _setupKYC(sender, 2);
        assertEq(kyc.getDailyLimit(sender), kyc.DEFAULT_T2_LIMIT());
    }

    // =========================================================================
    // Owner-gated functions
    // =========================================================================

    function test_SetPassOracle_Owner_Succeeds() public {
        address newOracle = makeAddr("newOracle");
        vm.expectEmit(true, true, false, false);
        emit IKYCRegistry.PassOracleUpdated(passOracle, newOracle);

        vm.prank(owner);
        kyc.setPassOracle(newOracle);
        assertEq(kyc.passOracle(), newOracle);
    }

    function test_RevertWhen_SetPassOracle_ZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(IKYCRegistry.ZeroAddress.selector);
        kyc.setPassOracle(address(0));
    }

    function test_RevertWhen_SetPassOracle_NotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        kyc.setPassOracle(makeAddr("newOracle"));
    }

    function test_SetDailyLimit_Tier1_Succeeds() public {
        uint256 newLimit = 1000e6;
        vm.expectEmit(true, false, false, true);
        emit IKYCRegistry.DailyLimitUpdated(uint8(1), newLimit);

        vm.prank(owner);
        kyc.setDailyLimit(1, newLimit);
        assertEq(kyc.dailyLimits(1), newLimit);
    }

    function test_RevertWhen_SetDailyLimit_InvalidTier() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IKYCRegistry.InvalidLevel.selector, uint8(3)));
        kyc.setDailyLimit(3, 1000e6);
    }

    function test_Pause_And_Unpause_Owner() public {
        vm.prank(owner);
        kyc.pause();
        assertTrue(kyc.paused());

        vm.prank(owner);
        kyc.unpause();
        assertFalse(kyc.paused());
    }

    function test_RevertWhen_Pause_NotOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        kyc.pause();
    }

    // =========================================================================
    // Constructor validation
    // =========================================================================

    function test_RevertWhen_Constructor_ZeroPassOracle() public {
        vm.expectRevert(IKYCRegistry.ZeroAddress.selector);
        new KYCRegistry(address(0), address(remit), owner);
    }

    function test_RevertWhen_Constructor_ZeroRemitChain() public {
        vm.expectRevert(IKYCRegistry.ZeroAddress.selector);
        new KYCRegistry(passOracle, address(0), owner);
    }
}
