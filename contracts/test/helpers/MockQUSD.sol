// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockQUSD
/// @notice Mock QUSD stablecoin for testing. 6 decimals, EIP-2612 permit support.
contract MockQUSD is ERC20, ERC20Permit {
    constructor() ERC20("Mock QUSD", "mQUSD") ERC20Permit("Mock QUSD") {}

    /// @notice Mint tokens for test setup. Anyone can call in tests.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
