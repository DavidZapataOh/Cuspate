// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PositionRouter} from "../../src/PositionRouter.sol";
import {PositionRouterSetup} from "../unit/PositionRouter.t.sol";

/// @title PositionRouterFuzzTest
/// @notice For any amount the seeded pools can absorb, in either world, an entry hands the recipient
///         exactly what the pool pays and exactly the dollars paid in the other leg, and the router
///         keeps nothing; for any amount they cannot, the entry is refused whole.
contract PositionRouterFuzzTest is PositionRouterSetup {
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
}
