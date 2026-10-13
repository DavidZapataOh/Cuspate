// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {PositionRouter} from "../../src/PositionRouter.sol";
import {FreezeHook} from "../../src/FreezeHook.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {FreezeHookSetup} from "./FreezeHook.t.sol";
import {TestCollateral} from "./PositionVault.t.sol";
import {TestStock} from "./MarketFactory.t.sol";

/// @notice A registered market whose yes and no pools are open at 1,040 and 960 dollars a share
///         and seeded a fifth either side, and the router over its hook. Shared by the unit and fuzz
///         tests of the router.
abstract contract PositionRouterSetup is FreezeHookSetup {
    using PoolIdLibrary for PoolKey;

    /// @notice The position seeded in each conditional pool, and its half-width in ticks.
    uint128 internal constant LIQUIDITY = 1e16;
    int24 internal constant HALF_WIDTH = 1823;

    PositionRouter internal router;
    PoolModifyLiquidityTest internal liquidityRouter;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;
    address internal user = makeAddr("user");

    /// @notice The market, its pools open and seeded, and the router.
    function setUp() public virtual override {
        super.setUp();
        (underlyingVault, dollarVault) = factory.markets(marketId);
        hook.register(underlying, dollar, eventId);
        liquidityRouter = new PoolModifyLiquidityTest(manager);
        _split(address(this), 100e18, 200_000e6);
        address[4] memory legs = [
            address(underlyingVault.YES()),
            address(underlyingVault.NO()),
            address(dollarVault.YES()),
            address(dollarVault.NO())
        ];
        for (uint256 index = 0; index < 4; index++) {
            IERC20(legs[index]).approve(address(liquidityRouter), type(uint256).max);
        }
        _open(yesKey, address(underlyingVault.YES()), 1040);
        _open(noKey, address(underlyingVault.NO()), 960);
        router = new PositionRouter(hook);
    }

    /// @notice What the pool pays for `dollars` of a world's dollar leg, measured by doing the same
    ///         split and swap by hand on a copy of the state that is then discarded.
    /// @param yes The world.
    /// @param dollars The amount.
    /// @return out The underlying leg received.
    function _poolOut(bool yes, uint256 dollars) internal returns (uint256 out) {
        uint256 snapshot = vm.snapshotState();
        address buyer = makeAddr("measuring buyer");
        _split(buyer, 0, dollars);
        PoolKey memory key = yes ? yesKey : noKey;
        address input = yes ? address(dollarVault.YES()) : address(dollarVault.NO());
        address output = yes ? address(underlyingVault.YES()) : address(underlyingVault.NO());
        bool zeroForOne = Currency.unwrap(key.currency0) == input;
        PoolSwapTest swapper = new PoolSwapTest(manager);
        vm.startPrank(buyer);
        IERC20(input).approve(address(swapper), dollars);
        swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -SafeCast.toInt256(dollars),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        out = IERC20(output).balanceOf(buyer);
        vm.revertToState(snapshot);
    }

    /// @notice Gives the user dollars and lets the router pull them.
    /// @param dollars How many.
    function _fundUser(uint256 dollars) internal {
        TestCollateral(address(dollar)).mint(user, dollars);
        vm.prank(user);
        dollar.approve(address(router), dollars);
    }

    /// @notice Asserts the router holds nothing of the collateral or of any leg.
    function _assertRouterHoldsNothing() internal view {
        address[6] memory tokens = [
            address(underlying),
            address(dollar),
            address(underlyingVault.YES()),
            address(underlyingVault.NO()),
            address(dollarVault.YES()),
            address(dollarVault.NO())
        ];
        for (uint256 index = 0; index < 6; index++) {
            assertEq(IERC20(tokens[index]).balanceOf(address(router)), 0, "the router holds funds");
            assertEq(IERC20(tokens[index]).allowance(address(router), address(dollarVault)), 0);
        }
    }

    /// @notice Opens a pool at a share's value in dollars and seeds it a fifth either side.
    /// @param key The pool.
    /// @param share The underlying leg in it.
    /// @param value The share's value in whole dollars.
    function _open(PoolKey memory key, address share, uint256 value) internal {
        int24 tick = manager.initialize(
            key, ConditionalPools.sqrtPriceX96(key, IERC20Metadata(share), value, 0)
        );
        int24 spacing = ConditionalPools.TICK_SPACING;
        int24 lower = tick - HALF_WIDTH;
        lower = lower / spacing * spacing - (lower % spacing < 0 ? spacing : int24(0));
        int24 upper = tick + HALF_WIDTH;
        upper = upper / spacing * spacing + (upper % spacing > 0 ? spacing : int24(0));
        liquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams(
                lower, upper, SafeCast.toInt256(uint256(LIQUIDITY)), 0
            ),
            ""
        );
    }

    /// @notice Gives `holder` legs of both vaults by splitting freshly minted collateral.
    /// @param holder Who receives the legs.
    /// @param shares How much of the underlying to split.
    /// @param dollars How much of the dollar to split.
    function _split(address holder, uint256 shares, uint256 dollars) internal {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        uint256[2] memory amounts = [shares, dollars];
        if (shares > 0) {
            TestStock(address(underlying)).mint(holder, shares);
        }
        if (dollars > 0) {
            TestCollateral(address(dollar)).mint(holder, dollars);
        }
        for (uint256 index = 0; index < 2; index++) {
            if (amounts[index] == 0) {
                continue;
            }
            vm.startPrank(holder);
            vaults[index].COLLATERAL().approve(address(vaults[index]), amounts[index]);
            vaults[index].splitPosition(amounts[index]);
            vm.stopPrank();
        }
    }
}

/// @title PositionRouterTest
/// @notice One call takes a user's dollars, splits them, sells the chosen world's dollar leg for that
///         world's share in the hooked pool, in full or not at all, and hands over the share and the
///         other dollar leg; every refusal comes before any funds move, and the router keeps nothing.
contract PositionRouterTest is PositionRouterSetup {
    using PoolIdLibrary for PoolKey;

    /// @notice A zero hook is refused. Listed alone: the coverage tool drops hits from the last
    ///         expected-revert creation in a test.
    function test_RevertWhen_theHookIsZero() public {
        vm.expectRevert(PositionRouter.ZeroAddress.selector);
        new PositionRouter(FreezeHook(address(0)));
        assertEq(address(router.HOOK()), address(hook));
    }

    /// @notice The router reads the pool manager and the factory from the hook.
    function test_theRouterReadsItsFactsFromTheHook() public view {
        assertEq(address(router.POOL_MANAGER()), address(manager));
        assertEq(address(router.FACTORY()), address(factory));
    }

    /// @notice Buying the stock only if the event happens: the user pays dollars and holds the yes
    ///         share the pool pays for the yes-dollars, plus every no-dollar.
    function test_enterTheYesWorld() public {
        _enterAndCheck(true, 100e6);
    }

    /// @notice The mirror: only if it does not happen.
    function test_enterTheNoWorld() public {
        _enterAndCheck(false, 100e6);
    }

    /// @notice Every refusal comes before any funds move: the user here has neither dollars nor an
    ///         allowance, so a pull attempted first would fail with the token's error, not these.
    function test_RevertWhen_anEntryIsMalformed() public {
        uint256 deadline = vm.getBlockTimestamp();
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.Expired.selector, deadline - 1));
        router.enter(marketId, true, 1e6, 1, user, deadline - 1);
        vm.expectRevert(PositionRouter.ZeroAmount.selector);
        router.enter(marketId, true, 0, 1, user, deadline);
        vm.expectRevert(PositionRouter.NoFloor.selector);
        router.enter(marketId, true, 1e6, 0, user, deadline);
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.BadRecipient.selector, address(0)));
        router.enter(marketId, true, 1e6, 1, address(0), deadline);
        vm.expectRevert(
            abi.encodeWithSelector(PositionRouter.BadRecipient.selector, address(router))
        );
        router.enter(marketId, true, 1e6, 1, address(router), deadline);
        vm.stopPrank();
    }

    /// @notice A market that does not exist, or exists but was never registered with the hook, is
    ///         refused before any funds move.
    function test_RevertWhen_theMarketHasNoPools() public {
        uint256 deadline = vm.getBlockTimestamp();
        bytes32 nowhere = keccak256("no such market");
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.NotAMarket.selector, nowhere));
        router.enter(nowhere, true, 1e6, 1, user, deadline);
        vm.stopPrank();
        bytes32 unregistered = factory.createMarket(
            underlying, dollar, _seal(sealer, announcesAt + 1), address(resolver)
        );
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.NotAMarket.selector, unregistered));
        vm.prank(user);
        router.enter(unregistered, true, 1e6, 1, user, deadline);
    }

    /// @notice An input larger than the pool can absorb before its price limit is refused whole,
    ///         rather than filled in part with the rest stranded.
    function test_RevertWhen_thePoolCannotTakeTheWholeInput() public {
        uint256 dollars = 10_000_000e6;
        _fundUser(dollars);
        vm.expectPartialRevert(PositionRouter.PartialFill.selector);
        vm.prank(user);
        router.enter(marketId, true, dollars, 1, user, vm.getBlockTimestamp());
    }

    /// @notice An output below the user's floor is refused.
    function test_RevertWhen_theOutputIsBelowTheFloor() public {
        uint256 out = _poolOut(true, 100e6);
        _fundUser(100e6);
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.TooLittleOut.selector, out, out + 1));
        vm.prank(user);
        router.enter(marketId, true, 100e6, out + 1, user, vm.getBlockTimestamp());
    }

    /// @notice From the freeze, the entry reverts with the hook's own error inside the manager's.
    function test_RevertWhen_theMarketIsFrozen() public {
        _fundUser(100e6);
        vm.warp(announcesAt);
        vm.expectRevert(_frozen(IHooks.beforeSwap.selector, yesKey, announcesAt));
        vm.prank(user);
        router.enter(marketId, true, 100e6, 1, user, vm.getBlockTimestamp());
    }

    /// @notice The callback answers only the pool manager.
    function test_RevertWhen_unlockCallbackCallerIsNotThePoolManager() public {
        vm.expectRevert(
            abi.encodeWithSelector(PositionRouter.NotPoolManager.selector, address(this))
        );
        router.unlockCallback("");
    }

    /// @notice Enters a world and checks every balance: the user's dollars are gone; the recipient
    ///         holds exactly what the pool pays and exactly `dollars` of the other dollar leg; the
    ///         router holds nothing; the event says the same.
    /// @param yes The world.
    /// @param dollars The amount.
    function _enterAndCheck(bool yes, uint256 dollars) internal {
        uint256 out = _poolOut(yes, dollars);
        _fundUser(dollars);
        address recipient = makeAddr("recipient");
        vm.expectEmit(address(router));
        emit PositionRouter.Entered(marketId, user, recipient, yes, dollars, out);
        vm.prank(user);
        assertEq(router.enter(marketId, yes, dollars, out, recipient, vm.getBlockTimestamp()), out);

        (IERC20 share, IERC20 kept) = yes
            ? (IERC20(address(underlyingVault.YES())), IERC20(address(dollarVault.NO())))
            : (IERC20(address(underlyingVault.NO())), IERC20(address(dollarVault.YES())));
        assertEq(share.balanceOf(recipient), out);
        assertEq(kept.balanceOf(recipient), dollars);
        assertEq(dollar.balanceOf(user), 0);
        assertGt(out, 0);
        _assertRouterHoldsNothing();
    }
}
