// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockQUSD is ERC20, Ownable {
    constructor() ERC20("QIE USD", "QUSD") Ownable(msg.sender) {
        // Mint 1,000,000 QUSD to the deployer
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }

    function decimals() public view virtual override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
