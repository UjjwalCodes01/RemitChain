// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MaliciousReceiver
/// @notice Simulates a recipient contract that attempts reentrancy attacks.
/// @dev    Used in tests to verify ReentrancyGuard is effective.
contract MaliciousReceiver {
    address public target;
    bytes public attackCalldata;
    bool public attackEnabled;
    bool public attacked;

    function setAttack(address _target, bytes calldata _calldata) external {
        target = _target;
        attackCalldata = _calldata;
        attackEnabled = true;
    }

    function disableAttack() external {
        attackEnabled = false;
    }

    /// @dev Called when ERC20 tokens are transferred to this contract.
    ///      Note: Standard ERC20 does NOT call receive() on transfer.
    ///      This is used if we test ETH-based reentrancy paths or hook scenarios.
    receive() external payable {
        if (attackEnabled && !attacked) {
            attacked = true;
            (bool success,) = target.call(attackCalldata);
            // We don't revert on failure — we capture it in tests via expectRevert on the outer call
            (success);
        }
    }

    /// @notice Fallback that attempts reentrancy when called.
    fallback() external payable {
        if (attackEnabled && !attacked) {
            attacked = true;
            (bool success,) = target.call(attackCalldata);
            (success);
        }
    }

    /// @notice Directly attempt a reentrant call. Used in test helpers.
    function attack() external {
        if (attackEnabled && !attacked) {
            attacked = true;
            (bool success,) = target.call(attackCalldata);
            (success);
        }
    }

    function resetAttack() external {
        attacked = false;
    }
}
