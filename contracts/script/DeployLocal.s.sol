// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {KYCRegistry} from "../src/KYCRegistry.sol";
import {EscrowVault} from "../src/EscrowVault.sol";
import {RemitChain} from "../src/RemitChain.sol";
import {MockQUSD} from "../src/MockQUSD.sol";

/// @title DeployLocal
/// @notice Deploys the full stack to a local anvil node for end-to-end testing.
/// @dev    LOCAL ONLY. It deliberately skips the TimelockController and uses a
///         mock token, both of which `Deploy.s.sol` forbids on mainnet. The
///         `require` below makes it impossible to point at a real network.
contract DeployLocal is Script {
    uint16 internal constant INITIAL_FEE_BPS = 10; // 0.1%

    function run() external {
        require(block.chainid == 31337, "DeployLocal is for anvil only");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address passOracle = vm.envAddress("PASS_ORACLE_ADDRESS");
        address feeTreasury = vm.envAddress("FEE_TREASURY_ADDRESS");

        vm.startBroadcast(deployerKey);

        MockQUSD qusd = new MockQUSD();

        uint256 nonce = vm.getNonce(deployer);
        address predictedKYC = vm.computeCreateAddress(deployer, nonce);
        address predictedVault = vm.computeCreateAddress(deployer, nonce + 1);
        address predictedRemit = vm.computeCreateAddress(deployer, nonce + 2);

        KYCRegistry kyc = new KYCRegistry(passOracle, predictedRemit, deployer);
        EscrowVault vault = new EscrowVault(address(qusd), predictedRemit, feeTreasury, INITIAL_FEE_BPS, deployer);
        RemitChain remit = new RemitChain(predictedKYC, predictedVault, address(qusd), deployer);

        require(address(kyc) == predictedKYC, "KYC address mismatch");
        require(address(vault) == predictedVault, "Vault address mismatch");
        require(address(remit) == predictedRemit, "Remit address mismatch");

        vm.stopBroadcast();

        console2.log("QUSD", address(qusd));
        console2.log("KYC", address(kyc));
        console2.log("VAULT", address(vault));
        console2.log("REMIT", address(remit));

        string memory json = string.concat(
            '{\n  "network": "anvil",\n  "chainId": 31337,\n',
            '  "deployer": "', vm.toString(deployer), '",\n',
            '  "contracts": {\n',
            '    "TimelockController": "', vm.toString(address(0)), '",\n',
            '    "KYCRegistry": "', vm.toString(address(kyc)), '",\n',
            '    "EscrowVault": "', vm.toString(address(vault)), '",\n',
            '    "RemitChain": "', vm.toString(address(remit)), '"\n  },\n',
            '  "config": {\n',
            '    "initialFeeBps": ', vm.toString(uint256(INITIAL_FEE_BPS)), ',\n',
            '    "qusd": "', vm.toString(address(qusd)), '",\n',
            '    "feeTreasury": "', vm.toString(feeTreasury), '"\n  }\n}'
        );
        vm.writeFile("deployments/anvil.json", json);
    }
}
