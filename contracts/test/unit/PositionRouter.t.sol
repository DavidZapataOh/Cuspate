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

    /// @notice The position seeded in the probability pool: both legs have six decimals.
    uint128 internal constant PROBABILITY_LIQUIDITY = 1e11;

    /// @notice The probability pool's opening: a yes-dollar at 0.6 dollars.
    uint256 internal constant YES_DOLLAR_PRICE = 0.6e18;
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
        hook.register(marketId, eventId);
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
        _open(yesKey, _valueOf(yesKey, address(underlyingVault.YES()), 1040), LIQUIDITY);
        _open(noKey, _valueOf(noKey, address(underlyingVault.NO()), 960), LIQUIDITY);
        _open(
            probabilityKey,
            ConditionalPools.sqrtPriceAtYesDollarPrice(dollarVault, YES_DOLLAR_PRICE),
            PROBABILITY_LIQUIDITY
        );
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

    /// @notice The opening price of a conditional pool at a share's value in whole dollars.
    /// @param key The pool.
    /// @param share The underlying leg in it.
    /// @param value The value.
    /// @return The sqrt price.
    function _valueOf(PoolKey memory key, address share, uint256 value)
        internal
        view
        returns (uint160)
    {
        return ConditionalPools.sqrtPriceX96(key, IERC20Metadata(share), value, 0);
    }

    /// @notice Opens a pool at a price and seeds it a fifth either side.
    /// @param key The pool.
    /// @param sqrtPriceX96 Its opening price.
    /// @param liquidity The position's liquidity.
    function _open(PoolKey memory key, uint160 sqrtPriceX96, uint128 liquidity) internal {
        int24 tick = manager.initialize(key, sqrtPriceX96);
        int24 spacing = ConditionalPools.TICK_SPACING;
        int24 lower = tick - HALF_WIDTH;
        lower = lower / spacing * spacing - (lower % spacing < 0 ? spacing : int24(0));
        int24 upper = tick + HALF_WIDTH;
        upper = upper / spacing * spacing + (upper % spacing > 0 ? spacing : int24(0));
        liquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams(
                lower, upper, SafeCast.toInt256(uint256(liquidity)), 0
            ),
            ""
        );
    }

    /// @notice The user enters a world with `dollars` and holds the position.
    /// @param yes The world.
    /// @param dollars The amount.
    /// @return shares The underlying leg bought.
    function _position(bool yes, uint256 dollars) internal returns (uint256 shares) {
        _fundUser(dollars);
        vm.prank(user);
        shares = router.enter(marketId, yes, dollars, 1, user, vm.getBlockTimestamp());
    }

    /// @notice What an exit does, done by hand with the pools and the vault on a copy of the state
    ///         that is then discarded: the sale, the level, the merge.
    /// @param order The exit.
    /// @return fill What it fills.
    function _handExit(PositionRouter.ExitOrder memory order)
        internal
        returns (PositionRouter.Fill memory fill)
    {
        uint256 snapshot = vm.snapshotState();
        (address share, address worldDollar, address keptDollar) = _legs(order.yes);
        fill.out = _handSwap(order.yes ? yesKey : noKey, share, order.shares);
        uint256 world = fill.out;
        uint256 kept = order.kept;
        if (order.level > 0) {
            address sold = order.levelSellsWorldDollar ? worldDollar : keptDollar;
            fill.levelOut = _handSwap(probabilityKey, sold, order.level);
            if (order.levelSellsWorldDollar) {
                (world, kept) = (world - order.level, kept + fill.levelOut);
            } else {
                (world, kept) = (world + fill.levelOut, kept - order.level);
            }
        }
        fill.dollars = world < kept ? world : kept;
        (uint256 yesDollars, uint256 noDollars) = order.yes ? (world, kept) : (kept, world);
        (fill.yesLeft, fill.noLeft) = (yesDollars - fill.dollars, noDollars - fill.dollars);
        vm.revertToState(snapshot);
    }

    /// @notice One exact-input swap by hand, from a fresh holder of the input.
    /// @param key The pool.
    /// @param input What is sold.
    /// @param amount How much.
    /// @return out What it pays.
    function _handSwap(PoolKey memory key, address input, uint256 amount)
        internal
        returns (uint256 out)
    {
        address seller = makeAddr("hand seller");
        bool zeroForOne = Currency.unwrap(key.currency0) == input;
        address output =
            zeroForOne ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        deal(input, seller, amount);
        PoolSwapTest swapper = new PoolSwapTest(manager);
        uint256 before = IERC20(output).balanceOf(seller);
        vm.startPrank(seller);
        IERC20(input).approve(address(swapper), amount);
        swapper.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -SafeCast.toInt256(amount),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        out = IERC20(output).balanceOf(seller) - before;
    }

    /// @notice A world's underlying leg, its dollar leg and the other world's dollar leg.
    /// @param yes The world.
    /// @return share The underlying leg.
    /// @return worldDollar The world's dollar leg.
    /// @return keptDollar The other world's dollar leg.
    function _legs(bool yes)
        internal
        view
        returns (address share, address worldDollar, address keptDollar)
    {
        return yes
            ? (
                address(underlyingVault.YES()),
                address(dollarVault.YES()),
                address(dollarVault.NO())
            )
            : (address(underlyingVault.NO()), address(dollarVault.NO()), address(dollarVault.YES()));
    }

    /// @notice An exit of the whole position, with the user's approvals in place.
    /// @param yes The world.
    /// @param shares The underlying leg held.
    /// @param kept The other world's dollar leg held.
    /// @return order The order, with no level and a floor of one.
    function _exitOrder(bool yes, uint256 shares, uint256 kept)
        internal
        returns (PositionRouter.ExitOrder memory order)
    {
        order = PositionRouter.ExitOrder({
            marketId: marketId,
            yes: yes,
            shares: shares,
            kept: kept,
            minOut: 1,
            levelSellsWorldDollar: false,
            level: 0,
            minLevelOut: 0,
            recipient: user,
            deadline: vm.getBlockTimestamp()
        });
        (address share,, address keptDollar) = _legs(yes);
        vm.startPrank(user);
        IERC20(share).approve(address(router), shares);
        IERC20(keptDollar).approve(address(router), kept);
        vm.stopPrank();
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
            underlying,
            dollar,
            _seal(sealer, announcesAt + 1),
            address(resolver),
            type(uint256).max,
            type(uint256).max
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

    /// @notice Exiting without levelling: the share is sold, the dollar legs that match are merged
    ///         into dollars, and the surplus leg comes back; everything equals the same steps done
    ///         by hand, and the router keeps nothing.
    function test_exitWithoutLevelling() public {
        uint256 shares = _position(true, 100e6);
        PositionRouter.ExitOrder memory order = _exitOrder(true, shares, 100e6);
        _exitAndCheck(order);
    }

    /// @notice A full exit: the surplus no-dollars are levelled into yes-dollars first, so almost
    ///         everything comes back as dollars; in both worlds.
    function test_exitLevelledInBothWorlds() public {
        bool[2] memory worlds = [true, false];
        for (uint256 index = 0; index < 2; index++) {
            uint256 shares = _position(worlds[index], 100e6);
            PositionRouter.ExitOrder memory order = _exitOrder(worlds[index], shares, 100e6);
            PositionRouter.Fill memory plain = _handExit(order);
            // The kept leg is the surplus; selling about this much of it levels the two, at a
            // yes-dollar of 0.6 and the fee, whichever world it is.
            uint256 surplus = 100e6 - plain.out;
            order.level = worlds[index] ? surplus * 1000 / 1665 : surplus * 1000 / 2496;
            order.minLevelOut = 1;
            PositionRouter.Fill memory fill = _exitAndCheck(order);
            assertLt(fill.yesLeft + fill.noLeft, surplus / 50, "the level left most of the surplus");
        }
    }

    /// @notice After the yes world's price rises enough, the sale fetches more yes-dollars than the
    ///         no-dollars kept, so the level sells the world's own dollar leg.
    function test_exitLevellingTheWorldLegAfterAGain() public {
        uint256 shares = _position(true, 100e6);
        // Someone buys the yes share with yes-dollars, raising its price well past the two fees.
        _handSwap(yesKey, address(dollarVault.YES()), 3_000e6);
        PositionRouter.ExitOrder memory order = _exitOrder(true, shares, 100e6);
        uint256 out = _handExit(order).out;
        assertGt(out, 100e6, "the price did not rise enough for the world leg to be the surplus");
        // Selling about this much of the yes-dollars for no-dollars at 1.5 each, less the fee,
        // levels the two.
        (order.levelSellsWorldDollar, order.level, order.minLevelOut) =
        (true, (out - 100e6) * 1000 / 2496, 1);
        PositionRouter.Fill memory fill = _exitAndCheck(order);
        assertLt(
            fill.yesLeft + fill.noLeft, (out - 100e6) / 50, "the level left most of the surplus"
        );
    }

    /// @notice Only the share, no kept leg: the share's dollars come back unmerged.
    function test_exitWithoutAKeptLeg() public {
        uint256 shares = _position(true, 100e6);
        PositionRouter.Fill memory fill = _exitAndCheck(_exitOrder(true, shares, 0));
        assertEq(fill.dollars, 0);
    }

    /// @notice Every malformed exit is refused before any funds move: the user here has approved
    ///         nothing, so a pull attempted first would fail with the token's error instead.
    function test_RevertWhen_anExitIsMalformed() public {
        PositionRouter.ExitOrder memory order = PositionRouter.ExitOrder({
            marketId: marketId,
            yes: true,
            shares: 1e15,
            kept: 1e6,
            minOut: 1,
            levelSellsWorldDollar: false,
            level: 0,
            minLevelOut: 0,
            recipient: user,
            deadline: vm.getBlockTimestamp()
        });
        vm.startPrank(user);
        order.deadline -= 1;
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.Expired.selector, order.deadline));
        router.exit(order);
        order.deadline += 1;
        order.shares = 0;
        vm.expectRevert(PositionRouter.ZeroAmount.selector);
        router.exit(order);
        order.shares = 1e15;
        order.minOut = 0;
        vm.expectRevert(PositionRouter.NoFloor.selector);
        router.exit(order);
        order.minOut = 1;
        order.level = 1;
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.LevelFloorMismatch.selector, 1, 0));
        router.exit(order);
        (order.level, order.minLevelOut) = (0, 1);
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.LevelFloorMismatch.selector, 0, 1));
        router.exit(order);
        order.minLevelOut = 0;
        order.recipient = address(router);
        vm.expectRevert(
            abi.encodeWithSelector(PositionRouter.BadRecipient.selector, address(router))
        );
        router.exit(order);
        order.recipient = user;
        order.marketId = keccak256("no such market");
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.NotAMarket.selector, order.marketId));
        router.exit(order);
        vm.stopPrank();
        // A market that exists but whose pools were never registered with the hook.
        order.marketId = factory.createMarket(
            underlying,
            dollar,
            _seal(sealer, announcesAt + 1),
            address(resolver),
            type(uint256).max,
            type(uint256).max
        );
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.NotAMarket.selector, order.marketId));
        vm.prank(user);
        router.exit(order);
    }

    /// @notice A level larger than the named leg's surplus is refused, and so is any level of a leg
    ///         that is not the larger.
    function test_RevertWhen_theLevelExceedsTheSurplus() public {
        uint256 shares = _position(true, 100e6);
        PositionRouter.ExitOrder memory order = _exitOrder(true, shares, 100e6);
        uint256 surplus = 100e6 - _handExit(order).out;
        (order.level, order.minLevelOut) = (surplus + 1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(PositionRouter.LevelTooLarge.selector, surplus + 1, surplus)
        );
        vm.prank(user);
        router.exit(order);
        (order.levelSellsWorldDollar, order.level) = (true, 1);
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.LevelTooLarge.selector, 1, 0));
        vm.prank(user);
        router.exit(order);
    }

    /// @notice Each swap has its own floor: the sale below its floor is refused, and the level below
    ///         its floor is refused.
    function test_RevertWhen_aSwapIsBelowItsFloor() public {
        uint256 shares = _position(false, 100e6);
        PositionRouter.ExitOrder memory order = _exitOrder(false, shares, 100e6);
        uint256 out = _handExit(order).out;
        order.minOut = out + 1;
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.TooLittleOut.selector, out, out + 1));
        vm.prank(user);
        router.exit(order);
        order.minOut = out;
        order.level = (100e6 - out) / 3;
        order.minLevelOut = 1;
        uint256 levelOut = _handExit(order).levelOut;
        order.minLevelOut = levelOut + 1;
        vm.expectRevert(
            abi.encodeWithSelector(PositionRouter.TooLittleOut.selector, levelOut, levelOut + 1)
        );
        vm.prank(user);
        router.exit(order);
    }

    /// @notice The sandwich a single floor on the merged dollars allowed: someone sells the share
    ///         just before the exit, which would have moved value out of the returned surplus; the
    ///         sale's own floor now refuses it.
    function test_RevertWhen_anExitIsSandwiched() public {
        uint256 shares = _position(true, 100e6);
        PositionRouter.ExitOrder memory order = _exitOrder(true, shares, 100e6);
        order.minOut = _handExit(order).out;
        _handSwapKept(yesKey, address(underlyingVault.YES()), 2e18);
        vm.expectPartialRevert(PositionRouter.TooLittleOut.selector);
        vm.prank(user);
        router.exit(order);
    }

    /// @notice From the freeze no exit is possible: the hook's error, with the world pool's id, in
    ///         both worlds.
    function test_RevertWhen_anExitMeetsTheFreeze() public {
        uint256 yesShares = _position(true, 100e6);
        uint256 noShares = _position(false, 100e6);
        PositionRouter.ExitOrder memory yesOrder = _exitOrder(true, yesShares, 100e6);
        PositionRouter.ExitOrder memory noOrder = _exitOrder(false, noShares, 100e6);
        vm.warp(announcesAt);
        yesOrder.deadline = announcesAt;
        noOrder.deadline = announcesAt;
        vm.expectRevert(_frozen(IHooks.beforeSwap.selector, yesKey, announcesAt));
        vm.prank(user);
        router.exit(yesOrder);
        vm.expectRevert(_frozen(IHooks.beforeSwap.selector, noKey, announcesAt));
        vm.prank(user);
        router.exit(noOrder);
    }

    /// @notice Exits and checks every balance against the same steps done by hand: the recipient
    ///         receives the dollars and both remainders, the holder's legs are gone, the router keeps
    ///         nothing, and the event says the same.
    /// @param order The exit.
    /// @return fill What it filled.
    function _exitAndCheck(PositionRouter.ExitOrder memory order)
        internal
        returns (PositionRouter.Fill memory fill)
    {
        PositionRouter.Fill memory expected = _handExit(order);
        uint256 dollarsBefore = dollar.balanceOf(user);
        uint256 yesBefore = dollarVault.YES().balanceOf(user) - (order.yes ? 0 : order.kept);
        uint256 noBefore = dollarVault.NO().balanceOf(user) - (order.yes ? order.kept : 0);
        vm.expectEmit(address(router));
        emit PositionRouter.Exited(order.marketId, user, order.recipient, order, expected);
        vm.prank(user);
        assertEq(router.exit(order), expected.dollars);
        assertEq(dollar.balanceOf(user) - dollarsBefore, expected.dollars);
        assertEq(dollarVault.YES().balanceOf(user) - yesBefore, expected.yesLeft);
        assertEq(dollarVault.NO().balanceOf(user) - noBefore, expected.noLeft);
        (address share,,) = _legs(order.yes);
        assertEq(IERC20(share).balanceOf(user), 0);
        assertEq(IERC20(share).allowance(user, address(router)), 0);
        _assertRouterHoldsNothing();
        fill = expected;
    }

    /// @notice A third party sells into a pool for real, moving its price.
    /// @param key The pool.
    /// @param input What is sold.
    /// @param amount How much.
    function _handSwapKept(PoolKey memory key, address input, uint256 amount) internal {
        _handSwap(key, input, amount);
    }

    /// @notice An entry without a floor is refused before any funds move.
    function test_RevertWhen_enterHasNoFloor() public {
        vm.expectRevert(PositionRouter.NoFloor.selector);
        vm.prank(user);
        router.enter(marketId, true, 1e6, 0, user, vm.getBlockTimestamp());
    }

    /// @notice An entry after its deadline is refused before any funds move.
    function test_RevertWhen_enterIsPastItsDeadline() public {
        uint256 deadline = vm.getBlockTimestamp() - 1;
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.Expired.selector, deadline));
        vm.prank(user);
        router.enter(marketId, true, 1e6, 1, user, deadline);
    }

    /// @notice An exit without a floor on its sale is refused before any funds move.
    function test_RevertWhen_exitHasNoFloor() public {
        PositionRouter.ExitOrder memory order = _unfundedExit();
        order.minOut = 0;
        vm.expectRevert(PositionRouter.NoFloor.selector);
        vm.prank(user);
        router.exit(order);
    }

    /// @notice An exit after its deadline is refused before any funds move.
    function test_RevertWhen_exitIsPastItsDeadline() public {
        PositionRouter.ExitOrder memory order = _unfundedExit();
        order.deadline -= 1;
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.Expired.selector, order.deadline));
        vm.prank(user);
        router.exit(order);
    }

    /// @notice An exit that levels without a floor on the level is refused before any funds move.
    function test_RevertWhen_exitLevelHasNoFloor() public {
        PositionRouter.ExitOrder memory order = _unfundedExit();
        order.level = 1;
        vm.expectRevert(abi.encodeWithSelector(PositionRouter.LevelFloorMismatch.selector, 1, 0));
        vm.prank(user);
        router.exit(order);
    }

    /// @notice A well-formed exit order for a user who holds and has approved nothing.
    /// @return order The order.
    function _unfundedExit() internal view returns (PositionRouter.ExitOrder memory order) {
        order = PositionRouter.ExitOrder({
            marketId: marketId,
            yes: true,
            shares: 1e15,
            kept: 1e6,
            minOut: 1,
            levelSellsWorldDollar: false,
            level: 0,
            minLevelOut: 0,
            recipient: user,
            deadline: vm.getBlockTimestamp()
        });
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
