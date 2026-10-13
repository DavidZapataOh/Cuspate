// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {PositionRouter} from "../../src/PositionRouter.sol";
import {PositionRouterSetup} from "../unit/PositionRouter.t.sol";

/// @title PositionRouterFuzzTest
/// @notice For any amount the seeded pools can absorb, in either world, an entry hands the recipient
///         exactly what the pool pays and exactly the dollars paid in the other leg, and the router
///         keeps nothing; for any amount they cannot, the entry is refused whole. And a position
///         entered and exited, levelled or not, never comes back worth more than it cost.
contract PositionRouterFuzzTest is PositionRouterSetup {
    using PoolIdLibrary for PoolKey;

    /// @notice An entry within the pools' depth hands over exactly the position.
    /// @param dollars How many dollars, from a thousandth of a cent to ten thousand dollars.
    /// @param yes The world.
    function testFuzz_anEntryHandsOverExactlyThePosition(uint256 dollars, bool yes) public {
        dollars = bound(dollars, 1e3, 10_000e6);
        uint256 out = _poolOut(yes, dollars);
        _fundUser(dollars);
        vm.prank(user);
        assertEq(router.enter(marketId, yes, dollars, out, user, vm.getBlockTimestamp()), out);
        (IERC20 share, IERC20 kept) = yes
            ? (IERC20(address(underlyingVault.YES())), IERC20(address(dollarVault.NO())))
            : (IERC20(address(underlyingVault.NO())), IERC20(address(dollarVault.YES())));
        assertEq(share.balanceOf(user), out);
        assertEq(kept.balanceOf(user), dollars);
        assertEq(dollar.balanceOf(user), 0);
        _assertRouterHoldsNothing();
    }

    /// @notice An entry beyond what the pools hold before their price limit is refused whole.
    /// @param dollars How many dollars, from a hundred thousand up.
    /// @param yes The world.
    function testFuzz_anEntryBeyondTheDepthIsRefusedWhole(uint256 dollars, bool yes) public {
        dollars = bound(dollars, 100_000e6, 1e30);
        _fundUser(dollars);
        vm.expectPartialRevert(PositionRouter.PartialFill.selector);
        vm.prank(user);
        router.enter(marketId, yes, dollars, 1, user, vm.getBlockTimestamp());
    }

    /// @notice Entering and exiting at once, levelled or not, never returns more value than was
    ///         paid: the dollars, plus each remaining dollar leg valued at the probability pool's
    ///         price read after the exit, are at most the dollars paid, the fees being the
    ///         difference.
    /// @param dollars How many dollars, from a cent to ten thousand dollars.
    /// @param yes The world.
    /// @param levelled Whether the exit levels the dollar legs first.
    function testFuzz_aRoundTripNeverReturnsMoreThanItCost(uint256 dollars, bool yes, bool levelled)
        public
    {
        dollars = bound(dollars, 1e4, 10_000e6);
        uint256 shares = _position(yes, dollars);
        PositionRouter.ExitOrder memory order = _exitOrder(yes, shares, dollars);
        if (levelled) {
            uint256 out = _handExit(order).out;
            uint256 surplus = dollars > out ? dollars - out : 0;
            uint256 level = yes ? surplus * 1000 / 1665 : surplus * 1000 / 2496;
            if (level > 1e3) {
                (order.level, order.minLevelOut) = (level, 1);
            }
        }
        vm.prank(user);
        router.exit(order);
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(manager, probabilityKey.toId());
        uint256 price = ConditionalPools.yesDollarPriceAt(dollarVault, sqrtPriceX96);
        uint256 value = dollar.balanceOf(user) * 1e18 + dollarVault.YES().balanceOf(user) * price
            + dollarVault.NO().balanceOf(user) * (1e18 - price);
        assertLe(value, dollars * 1e18, "a round trip returned more than it cost");
        _assertRouterHoldsNothing();
    }
}
