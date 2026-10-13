// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {FreezeHookSetup} from "../unit/FreezeHook.t.sol";

/// @title FreezeHookFuzzTest
/// @notice At any moment, a swap in any of a market's pools, either way, passes exactly when the
///         moment is before the sealed instant; and whenever the guardian acts, the instant only ever
///         falls, to the moment of acting.
contract FreezeHookFuzzTest is FreezeHookSetup {
    using PoolIdLibrary for PoolKey;

    /// @notice The registered market, its three pools opened.
    function setUp() public override {
        super.setUp();
        hook.register(underlying, dollar, eventId);
        PoolKey[3] memory keys = _keys();
        for (uint256 index = 0; index < 3; index++) {
            manager.initialize(keys[index], uint160(1 << 96));
        }
    }

    /// @notice A swap passes strictly before the instant and is refused at it and after it.
    /// @param moment When the swap is sent.
    /// @param pool Which of the three pools.
    /// @param zeroForOne Its direction.
    function testFuzz_aSwapPassesExactlyBeforeTheInstant(
        uint256 moment,
        uint8 pool,
        bool zeroForOne
    ) public {
        moment = bound(moment, vm.getBlockTimestamp(), announcesAt + 30 days);
        PoolKey memory key = _keys()[bound(pool, 0, 2)];
        vm.warp(moment);
        if (moment >= announcesAt) {
            vm.expectRevert(_frozen(IHooks.beforeSwap.selector, key, announcesAt));
        }
        _swap(key, zeroForOne);
    }

    /// @notice Whenever the guardian acts, each instant becomes the earlier of itself and the moment
    ///         of acting: never later, never reopened.
    /// @param moment When the guardian acts.
    function testFuzz_theGuardianOnlyBringsTheInstantForward(uint256 moment) public {
        moment = bound(moment, vm.getBlockTimestamp(), announcesAt + 30 days);
        vm.warp(moment);
        vm.prank(guardian);
        hook.freezeNow(marketId);
        uint256 expected = moment < announcesAt ? moment : announcesAt;
        PoolKey[3] memory keys = _keys();
        for (uint256 index = 0; index < 3; index++) {
            assertEq(hook.freezesAt(keys[index].toId()), expected);
        }
    }
}
