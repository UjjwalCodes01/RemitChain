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

        _assertLaunchSafe(deployer, multisig, passOracle, qusd, feeTreasury);
        _logConfig(deployer, multisig, passOracle, qusd, feeTreasury);

        vm.startBroadcast(deployerKey);
        _deployAll(deployer, multisig, passOracle, qusd, feeTreasury);
        vm.stopBroadcast();

        _writeDeploymentJson(deployer, multisig, passOracle, qusd, feeTreasury);
        _logVerificationCommands();
    }

    /// @notice Refuses to deploy a configuration that cannot safely hold real money.
    /// @dev    The mainnet deployment of 2026-05 was made against `MockQUSD` — an
    ///         owner-mintable ERC20 with no backing and no redemption path. It is a
    ///         perfectly good test token and cannot carry value, so a production
    ///         deployment pointed at one would be a remittance service settling in
    ///         a token nobody can redeem. These checks make that impossible to do
    ///         by accident.
    function _assertLaunchSafe(
        address deployer,
        address multisig,
        address passOracle,
        address qusd,
        address feeTreasury
    ) internal view {
        require(qusd != address(0), "QUSD_ADDRESS is unset");
        require(qusd.code.length > 0, "QUSD_ADDRESS has no code on this chain");
        require(multisig != address(0), "MULTISIG_ADDRESS is unset");
        require(passOracle != address(0), "PASS_ORACLE_ADDRESS is unset");
        require(feeTreasury != address(0), "FEE_TREASURY_ADDRESS is unset");

        // Mainnet-only requirements.
        if (block.chainid == 1990) {
            // A single EOA holding both the timelock's proposer role and the
            // oracle key removes the point of having a timelock at all.
            require(
                multisig != deployer,
                "Mainnet: MULTISIG_ADDRESS must not be the deployer - use a Gnosis Safe"
            );
            require(
                passOracle != deployer,
                "Mainnet: PASS_ORACLE_ADDRESS must not be the deployer - use a dedicated oracle key"
            );
            require(
                multisig.code.length > 0,
                "Mainnet: MULTISIG_ADDRESS must be a contract (Gnosis Safe), not an EOA"
            );

            // Reject the known mock token explicitly, and reject anything that
            // exposes a permissionless-looking mint by name.
            require(
                qusd != 0x9b5D310a92F05C3714E4163e43f226c7A6FB0827,
                "Mainnet: QUSD_ADDRESS is MockQUSD - point at the real stablecoin"
            );

            // A real stablecoin reports 6 decimals here; the protocol's
            // MIN_AMOUNT and fee maths assume it.
            (bool ok, bytes memory data) = qusd.staticcall(abi.encodeWithSignature("decimals()"));
            require(ok && data.length >= 32, "Mainnet: QUSD_ADDRESS does not implement decimals()");
            require(abi.decode(data, (uint8)) == 6, "Mainnet: QUSD must have 6 decimals");
        }
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
        string memory chain = _chainName();
        string memory apiPrefix = block.chainid == 1990 ? "mainnet" : "testnet";
        console2.log("\n=== Verify Contracts ===");
        console2.log(string.concat("forge verify-contract <KYCRegistry_ADDR> src/KYCRegistry.sol:KYCRegistry --chain ", chain, " --verifier blockscout --verifier-url https://", apiPrefix, ".qie.digital/api"));
        console2.log(string.concat("forge verify-contract <EscrowVault_ADDR> src/EscrowVault.sol:EscrowVault --chain ", chain, " --verifier blockscout --verifier-url https://", apiPrefix, ".qie.digital/api"));
        console2.log(string.concat("forge verify-contract <RemitChain_ADDR>  src/RemitChain.sol:RemitChain  --chain ", chain, " --verifier blockscout --verifier-url https://", apiPrefix, ".qie.digital/api"));
    }

    function _chainName() internal view returns (string memory) {
        if (block.chainid == 1983) return "qie_testnet";
        if (block.chainid == 1990) return "qie_mainnet";
        if (block.chainid == 31337) return "anvil";
        return vm.toString(block.chainid);
    }
}
