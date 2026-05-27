// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEscrowVault} from "./interfaces/IEscrowVault.sol";

/// @title EscrowVault
/// @notice Custodies QUSD stablecoin for pending RemitChain transfers.
/// @dev    Only the RemitChain contract (immutably set at deployment) may move funds.
///
/// @custom:security Pause MUST NOT block `refundFunds` — users must always be able to
///                  recover their funds after a transfer expires, even during an emergency.
///                  This invariant is enforced by the absence of `whenNotPaused` on `refundFunds`.
///
/// @custom:invariant QUSD.balanceOf(this) >= totalLocked at all times. Any excess (from
///                   accidental direct transfers) is safe. A deficit is impossible given
///                   correct CEI pattern and SafeERC20 usage.
contract EscrowVault is IEscrowVault, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // =========================================================================
    // Constants
    // =========================================================================

    /// @notice Hard cap on protocol fee: 1% (100 basis points).
    uint16 public constant MAX_FEE_BPS = 100;

    // =========================================================================
    // Immutables
    // =========================================================================

    /// @notice The QUSD stablecoin contract. Immutable — cannot be swapped post-deploy.
    IERC20 public immutable QUSD;

    /// @notice The RemitChain router. Only address permitted to call fund-moving functions.
    address public immutable remitChain;

    // =========================================================================
    // State
    // =========================================================================

    /// @notice Amount of QUSD locked per transferId.
    mapping(bytes32 => uint256) private _lockedBalance;

    /// @notice Sum of all pending locked balances. Used for the solvency invariant.
    uint256 private _totalLocked;

    /// @notice Address that receives protocol fees.
    address public feeTreasury;

    /// @notice Protocol fee in basis points (e.g., 10 = 0.1%). Max is MAX_FEE_BPS.
    uint16 public feeBps;

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @notice Initialises the EscrowVault.
    /// @param _qusd        The QUSD ERC20 token contract address.
    /// @param _remitChain  The RemitChain router address (immutable after deploy).
    /// @param _feeTreasury Address to receive protocol fees.
    /// @param _feeBps      Initial fee in basis points (≤ MAX_FEE_BPS).
    /// @param _owner       Initial owner — should be a TimelockController in production.
    constructor(address _qusd, address _remitChain, address _feeTreasury, uint16 _feeBps, address _owner)
        Ownable(_owner)
    {
        if (_qusd == address(0)) revert ZeroAddress();
        if (_remitChain == address(0)) revert ZeroAddress();
        if (_feeTreasury == address(0)) revert ZeroAddress();
        if (_feeBps > MAX_FEE_BPS) revert FeeBpsExceedsMax(_feeBps, MAX_FEE_BPS);

        QUSD = IERC20(_qusd);
        remitChain = _remitChain;
        feeTreasury = _feeTreasury;
        feeBps = _feeBps;
    }

    // =========================================================================
    // Modifiers
    // =========================================================================

    /// @dev Restricts a function to only the RemitChain router.
    modifier onlyRemitChain() {
        if (msg.sender != remitChain) revert CallerNotRemitChain(msg.sender);
        _;
    }

    // =========================================================================
    // External — fund-moving (onlyRemitChain)
    // =========================================================================

    /// @notice Locks QUSD from `sender` for a given `transferId`.
    /// @dev    CEI: check collision → update state (lockedBalance, totalLocked) → pull tokens.
    ///         nonReentrant + whenNotPaused guard. Rejects transferId collisions.
    ///         SafeERC20 handles non-standard ERC20 return values.
    /// @param transferId Unique transfer identifier.
    /// @param sender     The address to pull QUSD from (must have approved this vault).
    /// @param amount     Amount to lock in QUSD base units.
    function lockFunds(bytes32 transferId, address sender, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlyRemitChain
    {
        if (amount == 0) revert ZeroAmount();
        // Collision protection: transferId must not already hold funds.
        if (_lockedBalance[transferId] != 0) revert TransferIdCollision(transferId);

        // CEI: update state before external call
        _lockedBalance[transferId] = amount;
        _totalLocked += amount;

        emit FundsLocked(transferId, sender, amount);

        // External call last
        QUSD.safeTransferFrom(sender, address(this), amount);
    }

    /// @notice Releases locked QUSD to `recipient`, deducting the protocol fee.
    /// @dev    CEI: zero out lockedBalance → decrement totalLocked → transfer to recipient → fee.
    ///         nonReentrant + whenNotPaused. Fee rounds down by default (Solidity 0.8.24).
    /// @param transferId Unique transfer identifier.
    /// @param recipient  Address to receive the net transfer amount.
    function releaseFunds(bytes32 transferId, address recipient) external nonReentrant whenNotPaused onlyRemitChain {
        uint256 amount = _lockedBalance[transferId];
        if (amount == 0) revert TransferIdNotFound(transferId);
        if (recipient == address(0)) revert ZeroAddress();

        // Compute fee before zeroing state (needed for arithmetic, not an external call)
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 netAmount = amount - fee;

        // CEI: update state before any external calls
        _lockedBalance[transferId] = 0;
        _totalLocked -= amount;

        emit FundsReleased(transferId, recipient, netAmount, fee);

        // External calls last — recipient first, then treasury
        QUSD.safeTransfer(recipient, netAmount);
        if (fee > 0) {
            QUSD.safeTransfer(feeTreasury, fee);
        }
    }

    /// @notice Refunds the full locked amount to `sender`.
    /// @dev    CEI: zero out lockedBalance → decrement totalLocked → transfer back.
    ///         nonReentrant only — intentionally NOT whenNotPaused.
    ///
    /// @custom:security Refunds are never blocked by pause. This is a critical invariant:
    ///                  an admin cannot weaponize pause to trap user funds. Even if the vault
    ///                  is paused (e.g., oracle compromise, reentrancy incident), users whose
    ///                  transfers have expired can always recover their QUSD.
    /// @param transferId Unique transfer identifier.
    /// @param sender     Address to refund.
    function refundFunds(bytes32 transferId, address sender) external nonReentrant onlyRemitChain {
        uint256 amount = _lockedBalance[transferId];
        if (amount == 0) revert TransferIdNotFound(transferId);
        if (sender == address(0)) revert ZeroAddress();

        // CEI: update state before external call
        _lockedBalance[transferId] = 0;
        _totalLocked -= amount;

        emit FundsRefunded(transferId, sender, amount);

        // External call last
        QUSD.safeTransfer(sender, amount);
    }

    // =========================================================================
    // External — owner-gated (via TimelockController in production)
    // =========================================================================

    /// @notice Updates the protocol fee in basis points.
    /// @dev    Must be called via a 2-day TimelockController.
    /// @param newFeeBps New fee (must be ≤ MAX_FEE_BPS = 100).
    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeBpsExceedsMax(newFeeBps, MAX_FEE_BPS);
        uint16 old = feeBps;
        feeBps = newFeeBps;
        emit FeeBpsUpdated(old, newFeeBps);
    }

    /// @notice Updates the fee treasury address.
    /// @dev    Must be called via a 2-day TimelockController. Rejects zero address.
    /// @param newTreasury New treasury address.
    function setFeeTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address old = feeTreasury;
        feeTreasury = newTreasury;
        emit FeeTreasuryUpdated(old, newTreasury);
    }

    /// @notice Pauses the vault, blocking new locks and releases (but NOT refunds).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses the vault.
    function unpause() external onlyOwner {
        _unpause();
    }

    // =========================================================================
    // External — view
    // =========================================================================

    /// @notice Returns the amount of QUSD locked for a specific transferId.
    function lockedBalance(bytes32 transferId) external view returns (uint256) {
        return _lockedBalance[transferId];
    }

    /// @notice Returns the total QUSD currently locked across all pending transfers.
    function totalLocked() external view returns (uint256) {
        return _totalLocked;
    }
}
