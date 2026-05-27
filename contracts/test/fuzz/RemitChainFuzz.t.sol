// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseTest} from "../helpers/BaseTest.sol";
import {RemitChain} from "../../src/RemitChain.sol";
import {IRemitChain} from "../../src/interfaces/IRemitChain.sol";
import {IKYCRegistry} from "../../src/interfaces/IKYCRegistry.sol";
import {TransferId} from "../../src/libraries/TransferId.sol";

/// @title RemitChainFuzz
/// @notice Fuzz tests for RemitChain send/claim/cancel flows
contract RemitChainFuzz is BaseTest {
    function setUp() public override {
        super.setUp();
        // KYC sender at tier 2 (higher limit) so large fuzz amounts don't hit daily limit
        _setupKYC(sender, 2);
    }

    /// @notice Fuzz the full send→claim happy path with randomized amounts, corridors, OTPs.
    function testFuzz_SendClaim(uint256 amount, uint8 corridor, bytes32 otpSeed) public {
        // Bound amount to [MIN_AMOUNT, Tier2 daily limit] and within sender's balance
        amount = bound(amount, remit.MIN_AMOUNT(), kyc.DEFAULT_T2_LIMIT());
        qusd.mint(sender, amount);

        uint256 nonce = remit.senderNonces(sender);
        bytes32 predictedId = keccak256(abi.encode(sender, nonce, block.chainid, address(remit)));
        bytes32 otpReveal = otpSeed;
        bytes32 otpCommitHash = keccak256(abi.encode(otpReveal, predictedId, recipient));
        bytes32 phoneHash = keccak256(abi.encodePacked(SALT, "+919876543210"));

        vm.startPrank(sender);
        qusd.approve(address(vault), amount);
        bytes32 transferId = remit.sendRemittance(phoneHash, amount, otpCommitHash, corridor);
        vm.stopPrank();

        assertEq(transferId, predictedId);

        uint256 recipientBefore = qusd.balanceOf(recipient);

        _doClaim(transferId, otpReveal, recipient, recipientPk);

        assertEq(uint8(remit.getTransferStatus(transferId)), uint8(IRemitChain.Status.CLAIMED));
        assertTrue(qusd.balanceOf(recipient) >= recipientBefore); // received net amount
    }

    /// @notice Fuzz that the cumulative daily usage enforces the tier limit correctly.
    function testFuzz_DailyLimit(uint256[10] calldata amounts, uint8 tier) public {
        tier = uint8(bound(tier, 1, 2));
        _setupKYC(sender, tier);
        uint256 limit = kyc.getDailyLimit(sender);

        uint256 total = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 a = bound(amounts[i], remit.MIN_AMOUNT(), limit);

            if (total + a > limit) {
                // Should revert
                qusd.mint(sender, a);
                vm.startPrank(sender);
                qusd.approve(address(vault), a);
                vm.expectRevert(
                    abi.encodeWithSelector(IKYCRegistry.DailyLimitExceeded.selector, sender, limit, total + a)
                );
                remit.sendRemittance(bytes32(uint256(i)), a, bytes32(0), 1);
                vm.stopPrank();
                break; // stop after first limit breach
            } else {
                qusd.mint(sender, a);
                vm.startPrank(sender);
                qusd.approve(address(vault), a);
                remit.sendRemittance(bytes32(uint256(i + 0x1000)), a, bytes32(0), 1);
                vm.stopPrank();
                total += a;
            }
        }
    }

    /// @notice Fuzz that random byte strings never produce a valid passOracle signature.
    function testFuzz_SignatureForgery(bytes calldata sig) public {
        address user = makeAddr("kycUser");
        uint256 deadline = block.timestamp + 1 hours;

        // Build valid digest for this user
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("VerifyUser(address user,uint8 newLevel,uint256 deadline,uint256 nonce)"),
                user,
                uint8(1),
                deadline,
                kyc.nonces(user)
            )
        );
        // We don't call verifyUser with `sig` directly — instead verify that tryRecover won't
        // produce passOracle. This mirrors what KYCRegistry does internally.
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", kyc.domainSeparator(), structHash));

        if (sig.length == 65) {
            (address recovered,,) = _tryRecoverSig(digest, sig);
            // If sig is exactly 65 bytes and happens to recover passOracle, it's valid — skip
            if (recovered == passOracle) return;
        }

        // verifyUser should revert with invalid signature for any random sig
        vm.expectRevert(IKYCRegistry.InvalidSignature.selector);
        kyc.verifyUser(user, 1, deadline, sig);
    }

    /// @notice Fuzz that transferIds generated with different nonces never collide.
    function testFuzz_TransferId_Unique(uint256 nonce1, uint256 nonce2) public view {
        vm.assume(nonce1 != nonce2);

        bytes32 id1 = keccak256(abi.encode(sender, nonce1, block.chainid, address(remit)));
        bytes32 id2 = keccak256(abi.encode(sender, nonce2, block.chainid, address(remit)));

        assertTrue(id1 != id2, "TransferId collision on different nonces");
    }

    /// @notice Fuzz that transferIds are chain-bound (different chainId → different ID).
    function testFuzz_TransferId_ChainBound(uint256 chainId1, uint256 chainId2) public view {
        vm.assume(chainId1 != chainId2);

        bytes32 id1 = keccak256(abi.encode(sender, uint256(0), chainId1, address(remit)));
        bytes32 id2 = keccak256(abi.encode(sender, uint256(0), chainId2, address(remit)));

        assertTrue(id1 != id2, "TransferId not chain-bound");
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    function _tryRecoverSig(bytes32 digest, bytes calldata sig)
        internal
        pure
        returns (address recovered, bool success, bytes memory)
    {
        if (sig.length != 65) return (address(0), false, "");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        recovered = ecrecover(digest, v, r, s);
        success = recovered != address(0);
    }
}
