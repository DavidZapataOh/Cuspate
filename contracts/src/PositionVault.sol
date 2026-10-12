// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PositionToken} from "./PositionToken.sol";

/// @title PositionVault
/// @notice Holds one collateral and splits it into two legs, one for each outcome, at exactly one
///         to one. Holding one of each leg is holding one unit of collateral: at any moment the two
///         merge and the collateral comes back.
contract PositionVault {
    using SafeERC20 for IERC20;

    /// @notice Thrown when the collateral that actually moved differs from the amount.
    /// @param expected The amount the call asked to move.
    /// @param moved What the vault's balance actually changed by.
    error CollateralMismatch(uint256 expected, uint256 moved);

    /// @notice Emitted when collateral is split into one of each leg.
    /// @param stakeholder Who split.
    /// @param amount How much collateral, and how much of each leg.
    event PositionSplit(address indexed stakeholder, uint256 amount);

    /// @notice Emitted when one of each leg is merged back into collateral.
    /// @param stakeholder Who merged.
    /// @param amount How much of each leg, and how much collateral.
    event PositionsMerge(address indexed stakeholder, uint256 amount);

    /// @notice The collateral this vault holds.
    IERC20 public immutable COLLATERAL;

    /// @notice The leg that pays if the outcome resolves true. This vault is its only minter.
    PositionToken public immutable YES;

    /// @notice The leg that pays if the outcome resolves false. This vault is its only minter.
    PositionToken public immutable NO;

    /// @notice Creates the vault and both of its legs, which take the collateral's decimals.
    /// @param collateral The collateral this vault will hold.
    /// @param yesName The name of the leg that pays if the outcome is true.
    /// @param yesSymbol Its symbol.
    /// @param noName The name of the leg that pays if the outcome is false.
    /// @param noSymbol Its symbol.
    constructor(
        IERC20 collateral,
        string memory yesName,
        string memory yesSymbol,
        string memory noName,
        string memory noSymbol
    ) {
        uint8 collateralDecimals = IERC20Metadata(address(collateral)).decimals();
        COLLATERAL = collateral;
        YES = new PositionToken(yesName, yesSymbol, collateralDecimals, address(this));
        NO = new PositionToken(noName, noSymbol, collateralDecimals, address(this));
    }

    /// @notice Takes an amount of collateral from the caller and gives back that amount of each leg.
    /// @param amount How much collateral to split.
    function splitPosition(uint256 amount) external {
        // Announced before any external call, so a reentrant call cannot place its own event
        // ahead of this one; if anything below reverts, the event goes with it.
        emit PositionSplit(msg.sender, amount);
        uint256 before = COLLATERAL.balanceOf(address(this));
        COLLATERAL.safeTransferFrom(msg.sender, address(this), amount);
        _requireMoved(amount, before, COLLATERAL.balanceOf(address(this)));
        YES.mint(msg.sender, amount);
        NO.mint(msg.sender, amount);
    }

    /// @notice Takes an amount of each leg from the caller and gives back that amount of collateral.
    /// @param amount How much of each leg to merge.
    function mergePositions(uint256 amount) external {
        emit PositionsMerge(msg.sender, amount);
        YES.burn(msg.sender, amount);
        NO.burn(msg.sender, amount);
        uint256 before = COLLATERAL.balanceOf(address(this));
        COLLATERAL.safeTransfer(msg.sender, amount);
        _requireMoved(amount, COLLATERAL.balanceOf(address(this)), before);
    }

    /// @notice Refuses any transfer that moved a different amount of collateral than asked, in
    ///         either direction.
    /// @dev The collateral is chosen by the market, and its transfer behaviour can be replaced by a
    ///      key outside this protocol. On a split this keeps every leg backed: trusting the amount
    ///      would let a collateral that began to charge on transfer mint legs against nothing. On a
    ///      merge it keeps the vault whole against a transfer that takes more than it sends; a fee
    ///      taken from what the holder receives leaves the vault whole and is the holder's loss.
    ///      Ordered as low and high so that a balance moving the wrong way, as a reentrant call can
    ///      make it, is refused by this error rather than by an arithmetic panic.
    /// @param expected The amount the call asked to move.
    /// @param low The balance the vault should have been at the low end of the movement.
    /// @param high The balance at the high end.
    function _requireMoved(uint256 expected, uint256 low, uint256 high) private pure {
        uint256 moved = high > low ? high - low : 0;
        if (high < low || moved != expected) {
            revert CollateralMismatch(expected, moved);
        }
    }
}
