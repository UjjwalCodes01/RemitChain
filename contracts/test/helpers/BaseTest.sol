// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {MockQUSD} from "./MockQUSD.sol";
import {MaliciousReceiver} from "./MaliciousReceiver.sol";
import {KYCRegistry} from "../../src/KYCRegistry.sol";
import {EscrowVault} from "../../src/EscrowVault.sol";
import {RemitChain} from "../../src/RemitChain.sol";
import {IRemitChain} from "../../src/interfaces/IRemitChain.sol";

/// @title BaseTest
/// @notice Shared setup, signers, and helpers for all RemitChain tests.
abstract contract BaseTest is Test {
    // =========================================================================
    // Accounts
    // =========================================================================

    address internal owner;
    uint256 internal ownerPk;

    address internal passOracle;
    uint256 internal passOraclePk;

    address internal sender;
    uint256 internal senderPk;

    address internal recipient;
    uint256 internal recipientPk;

    address internal relayer;
    address internal attacker;
    address internal feeTreasury;
    address internal multisig;

    // =========================================================================
    // Contracts
    // =========================================================================

    MockQUSD internal qusd;
    MaliciousReceiver internal malicious;
    TimelockController internal timelock;
    KYCRegistry internal kyc;
    EscrowVault internal vault;
    RemitChain internal remit;

    // =========================================================================
    // Test constants
    // =========================================================================

    uint256 internal constant INITIAL_BALANCE = 100_000e6; // 100k QUSD
    uint16 internal constant DEFAULT_FEE_BPS = 10; // 0.1%
    bytes32 internal constant SALT = bytes32(uint256(0xDEADBEEF));

    // =========================================================================
    // Setup
    // =========================================================================

    function setUp() public virtual {
        // Create named accounts with deterministic keys
        (owner, ownerPk) = makeAddrAndKey("owner");
        (passOracle, passOraclePk) = makeAddrAndKey("passOracle");
        (sender, senderPk) = makeAddrAndKey("sender");
        (recipient, recipientPk) = makeAddrAndKey("recipient");
        relayer = makeAddr("relayer");
        attacker = makeAddr("attacker");
        feeTreasury = makeAddr("feeTreasury");
        multisig = makeAddr("multisig");

        // Deploy MockQUSD
        qusd = new MockQUSD();

        // Deploy MaliciousReceiver
        malicious = new MaliciousReceiver();

        _deploySystem();

        // Mint QUSD to sender and attacker
        qusd.mint(sender, INITIAL_BALANCE);
        qusd.mint(attacker, INITIAL_BALANCE);
        qusd.mint(address(malicious), 1e6);
    }

    function _deploySystem() internal {
        // 1. Deploy KYCRegistry with temporary zero remitChain — we'll use a proper deploy in prod
        // In tests: we need to know remitChain before deploying KYCRegistry
        // Strategy: compute RemitChain address ahead of time using nonce
        uint256 nonceBefore = vm.getNonce(address(this));

        // KYCRegistry will be deployed at nonce N
        // EscrowVault will be deployed at nonce N+1
        // RemitChain will be deployed at nonce N+2
        address predictedKYC = vm.computeCreateAddress(address(this), nonceBefore);
        address predictedVault = vm.computeCreateAddress(address(this), nonceBefore + 1);
        address predictedRemit = vm.computeCreateAddress(address(this), nonceBefore + 2);

        kyc = new KYCRegistry(passOracle, predictedRemit, owner);
        vault = new EscrowVault(address(qusd), predictedRemit, feeTreasury, DEFAULT_FEE_BPS, owner);
        remit = new RemitChain(predictedKYC, predictedVault, address(qusd), owner);

        require(address(kyc) == predictedKYC, "KYC address mismatch");
        require(address(vault) == predictedVault, "Vault address mismatch");
        require(address(remit) == predictedRemit, "Remit address mismatch");
    }

    // =========================================================================
    // Helpers — KYC
    // =========================================================================

    /// @notice Signs a KYC attestation as passOracle and calls verifyUser.
    function _setupKYC(address user, uint8 level) internal {
        _setupKYCWithDeadline(user, level, block.timestamp + 1 hours);
    }

    function _setupKYCWithDeadline(address user, uint8 level, uint256 deadline) internal {
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
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(passOracle);
        kyc.verifyUser(user, level, deadline, sig);
    }

    // =========================================================================
    // Helpers — Send
    // =========================================================================

    /// @notice Helper: sender approves vault and calls sendRemittance.
    /// @return transferId  The generated transfer ID.
    /// @return otpReveal   The raw OTP reveal (so tests can use it in claims).
    function _doSend(address _sender, uint256 amount, bytes32 otpSeed, address _recipient)
        internal
        returns (bytes32 transferId, bytes32 otpReveal)
    {
        // Compute transferId that will be generated (peek at nonce)
        uint256 nextNonce = remit.senderNonces(_sender);
        bytes32 predictedId = keccak256(abi.encode(_sender, nextNonce, block.chainid, address(remit)));

        otpReveal = otpSeed;
        bytes32 otpCommitHash = keccak256(abi.encode(otpReveal, predictedId, _recipient));
        bytes32 recipientPhoneHash = keccak256(abi.encodePacked(SALT, "+919876543210"));

        vm.startPrank(_sender);
        qusd.approve(address(vault), amount);
        transferId = remit.sendRemittance(recipientPhoneHash, amount, otpCommitHash, 1);
        vm.stopPrank();

        require(transferId == predictedId, "TransferId prediction mismatch");
    }

    // =========================================================================
    // Helpers — Claim
    // =========================================================================

    /// @notice Helper: signs claim payload as recipient and calls claimRemittance as relayer.
    function _doClaim(bytes32 transferId, bytes32 otpReveal, address _recipient, uint256 _recipientPk) internal {
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
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        remit.claimRemittance(transferId, otpReveal, _recipient, deadline, sig);
    }
}
