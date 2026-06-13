// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MockQUSD} from "../src/MockQUSD.sol";

contract DeployQUSD is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        MockQUSD qusd = new MockQUSD();
        console2.log("MockQUSD deployed to:", address(qusd));
        
        // Mint to relayer
        address relayer = 0x8E1Ea95ecfa447F034bF47f325cb98d7F703a9AC;
        qusd.mint(relayer, 10000 * 10**6);
        console2.log("Minted 10000 QUSD to relayer");

        vm.stopBroadcast();
    }
}
