// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EscrowVault} from "../src/EscrowVault.sol";
import {RemitChain} from "../src/RemitChain.sol";

/// @title Deploy
/// @notice Deployment script for all RemitChain contracts.
/// @dev    Required env vars:
///         DEPLOYER_PRIVATE_KEY  — deployer key (server-side only, never client-exposed)
///         MULTISIG_ADDRESS      — Gnosis Safe; becomes TimelockController proposer + executor
///         PASS_ORACLE_ADDRESS   — QIE Pass trusted signer
///         QUSD_ADDRESS          — QUSD stablecoin on target chain
///         FEE_TREASURY_ADDRESS  — Protocol fee recipient
///
/// @custom:security DEPLOYER_PRIVATE_KEY must remain server-side only.
contract Deploy is Script {
    uint256 internal constant TIMELOCK_MIN_DELAY = 2 days;
    uint16 internal constant INITIAL_FEE_BPS = 10; // 0.1%

    TimelockController public timelock;
    KYCRegistry public kyc;
    EscrowVault public vault;
    RemitChain public remit;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address multisig = vm.envAddress("MULTISIG_ADDRESS");
        address passOracle = vm.envAddress("PASS_ORACLE_ADDRESS");
        address qusd = vm.envAddress("QUSD_ADDRESS");
        address feeTreasury = vm.envAddress("FEE_TREASURY_ADDRESS");

        _logConfig(deployer, multisig, passOracle, qusd, feeTreasury);

        vm.startBroadcast(deployerKey);
        _deployAll(deployer, multisig, passOracle, qusd, feeTreasury);
        vm.stopBroadcast();

        _writeDeploymentJson(deployer, multisig, passOracle, qusd, feeTreasury);
        _logVerificationCommands();
    }

    function _deployAll(address deployer, address multisig, address passOracle, address qusd, address feeTreasury)
        internal
    {
        // Step 1: TimelockController
        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        address[] memory executors = new address[](1);
        executors[0] = multisig;
        timelock = new TimelockController(TIMELOCK_MIN_DELAY, proposers, executors, address(0));
        console2.log("TimelockController:", address(timelock));

        // Step 2-4: Deploy with nonce-prediction for cross-referencing immutables
        uint256 deployerNonce = vm.getNonce(deployer);
        address predictedKYC = vm.computeCreateAddress(deployer, deployerNonce);
        address predictedVault = vm.computeCreateAddress(deployer, deployerNonce + 1);
        address predictedRemit = vm.computeCreateAddress(deployer, deployerNonce + 2);

        kyc = new KYCRegistry(passOracle, predictedRemit, deployer);
        require(address(kyc) == predictedKYC, "KYC address mismatch");
        console2.log("KYCRegistry:", address(kyc));

        vault = new EscrowVault(qusd, predictedRemit, feeTreasury, INITIAL_FEE_BPS, deployer);
        require(address(vault) == predictedVault, "Vault address mismatch");
        console2.log("EscrowVault:", address(vault));

        remit = new RemitChain(predictedKYC, predictedVault, qusd, deployer);
        require(address(remit) == predictedRemit, "Remit address mismatch");
        console2.log("RemitChain:", address(remit));

        // Step 5: Transfer ownership to TimelockController (Ownable2Step — pending acceptance)
        kyc.transferOwnership(address(timelock));
        vault.transferOwnership(address(timelock));
        remit.transferOwnership(address(timelock));
        console2.log("Ownership transferred to TimelockController (2-step - must accept)");
    }

    function _logConfig(address deployer, address multisig, address passOracle, address qusd, address feeTreasury)
        internal
        view
    {
        console2.log("=== RemitChain Deployment ===");
        console2.log("Deployer    :", deployer);
        console2.log("Multisig    :", multisig);
        console2.log("PassOracle  :", passOracle);
        console2.log("QUSD        :", qusd);
        console2.log("FeeTreasury :", feeTreasury);
        console2.log("Chain ID    :", block.chainid);
    }

    function _writeDeploymentJson(
        address deployer,
        address multisig,
        address passOracle,
        address qusd,
        address feeTreasury
    ) internal {
        string memory chain = _chainName();
        // Build JSON in parts to avoid stack-too-deep
        string memory part1 = string.concat(
            '{\n  "network": "',
            chain,
            '",\n',
            '  "chainId": ',
            vm.toString(block.chainid),
            ",\n",
            '  "deployer": "',
            vm.toString(deployer),
            '",\n'
        );
        string memory part2 = string.concat(
            '  "contracts": {\n',
            '    "TimelockController": "',
            vm.toString(address(timelock)),
            '",\n',
            '    "KYCRegistry": "',
            vm.toString(address(kyc)),
            '",\n',
            '    "EscrowVault": "',
            vm.toString(address(vault)),
            '",\n',
            '    "RemitChain": "',
            vm.toString(address(remit)),
            '"\n',
            "  },\n"
        );
        string memory part3 = string.concat(
            '  "config": {\n',
            '    "timelockMinDelay": ',
            vm.toString(TIMELOCK_MIN_DELAY),
            ",\n",
            '    "initialFeeBps": ',
            vm.toString(uint256(INITIAL_FEE_BPS)),
            ",\n",
            '    "multisig": "',
            vm.toString(multisig),
            '",\n',
            '    "passOracle": "',
            vm.toString(passOracle),
            '",\n',
            '    "qusd": "',
            vm.toString(qusd),
            '",\n',
            '    "feeTreasury": "',
            vm.toString(feeTreasury),
            '"\n',
            "  }\n}"
        );
        string memory json = string.concat(part1, part2, part3);
        string memory filename = string.concat("deployments/", chain, ".json");
        vm.writeFile(filename, json);
        console2.log("Deployment written to:", filename);
    }

    function _logVerificationCommands() internal view {
        console2.log("\n=== Verify Contracts ===");
        console2.log("forge verify-contract <KYCRegistry_ADDR> src/KYCRegistry.sol:KYCRegistry --chain qie_testnet");
        console2.log("forge verify-contract <EscrowVault_ADDR> src/EscrowVault.sol:EscrowVault --chain qie_testnet");
        console2.log("forge verify-contract <RemitChain_ADDR>  src/RemitChain.sol:RemitChain  --chain qie_testnet");
    }

    function _chainName() internal view returns (string memory) {
        if (block.chainid == 1983) return "qie_testnet";
        if (block.chainid == 31337) return "anvil";
        return vm.toString(block.chainid);
    }
}
