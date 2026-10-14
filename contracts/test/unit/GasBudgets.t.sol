// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {CreProposer} from "../../src/CreProposer.sol";
import {FreezeHook} from "../../src/FreezeHook.sol";
import {PositionRouter} from "../../src/PositionRouter.sol";
import {
    IERC20Metadata as Metadata
} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {TestCollateral} from "./PositionVault.t.sol";
import {TestStock} from "./MarketFactory.t.sol";
import {TestnetDollar} from "../../src/testnet/TestnetDollar.sol";
import {TestnetStock} from "../../src/testnet/TestnetStock.sol";
import {TestnetReportProbe} from "../../src/testnet/TestnetReportProbe.sol";
import {TestnetStockOracle} from "../../src/testnet/TestnetStockOracle.sol";
import {TestnetToken} from "../../src/testnet/TestnetToken.sol";

/// @title GasCases
/// @notice Every entry point a user or a pool calls, performed as its own transaction in the worst
///         case a user can meet and in the steady case most meet, and recorded under
///         `<Contract>.<function> <case>`. Each worst case is checked before the call, so a change to
///         the fixture cannot quietly turn it into a cheaper one.
/// @dev Recorded under isolation, so each value is receipt gas: intrinsic cost and calldata included.
abstract contract GasCases is Test {
    using PoolIdLibrary for PoolKey;

    bytes32 internal constant EVENT = keccak256("an event");

    address internal resolver = makeAddr("resolver");

    MarketFactory internal factory;
    ThresholdRegistry internal registry;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;

    /// @notice The file the values are recorded in.
    /// @return The group.
    function _group() internal pure virtual returns (string memory);

    /// @notice The two collaterals the market is created over.
    /// @return underlying The underlying.
    /// @return dollar The dollar.
    function _collaterals() internal virtual returns (IERC20 underlying, IERC20 dollar);

    /// @notice The pool manager the router cases trade through.
    /// @return The manager.
    function _manager() internal virtual returns (IPoolManager);

    /// @notice A market over the two collaterals.
    function setUp() public virtual {
        (IERC20 underlying, IERC20 dollar) = _collaterals();
        factory = new MarketFactory();
        registry = new ThresholdRegistry();
        (underlyingVault, dollarVault) = factory.markets(
            factory.createMarket(
                underlying, dollar, EVENT, resolver, type(uint256).max, type(uint256).max
            )
        );
    }

    /// @notice Creating a market: two vaults and four legs, at the collaterals' symbol lengths.
    function test_createMarket() public {
        IERC20 underlying = underlyingVault.COLLATERAL();
        IERC20 dollar = dollarVault.COLLATERAL();
        string memory symbols = string.concat(
            IERC20Metadata(address(underlying)).symbol(),
            " and ",
            IERC20Metadata(address(dollar)).symbol()
        );
        factory.createMarket(
            underlying,
            dollar,
            keccak256("another event"),
            resolver,
            type(uint256).max,
            type(uint256).max
        );
        _record("MarketFactory.createMarket over ", symbols);
    }

    /// @notice Sealing a threshold, with one-slot terms and with terms of the length a real market
    ///         needs.
    function test_seal() public {
        uint256[2] memory lengths = [uint256(31), 500];
        string[2] memory cases = [
            "ThresholdRegistry.seal terms of 31 bytes", "ThresholdRegistry.seal terms of 500 bytes"
        ];
        for (uint256 i = 0; i < 2; i++) {
            // Written out, not zeroed: storing a zero byte is nearly free, so empty terms would
            // understate what any real terms cost.
            bytes memory terms = new bytes(lengths[i]);
            for (uint256 j = 0; j < terms.length; j++) {
                terms[j] = "a";
            }
            ThresholdRegistry.Threshold memory threshold = ThresholdRegistry.Threshold({
                value: 123,
                decimals: 2,
                announcesAt: uint64(vm.getBlockTimestamp() + 1 days),
                deadline: uint64(vm.getBlockTimestamp() + 9 days),
                terms: terms
            });
            registry.seal(threshold);
            _record(cases[i], "");
        }
    }

    /// @notice A resolver's life for two events: a figure proposed, settled and its bond withdrawn, and
    ///         an event proposed invalid after its deadline. Each in its worst case: the resolver's first
    ///         bond, the proposer's first credit, a withdrawal to a proposer left with nothing.
    function test_resolver() public {
        IERC20 bondToken = dollarVault.COLLATERAL();
        uint256 bond = 10 ** IERC20Metadata(address(bondToken)).decimals();
        OptimisticResolver resolver_ = new OptimisticResolver(
            factory,
            registry,
            address(this),
            address(this),
            bondToken,
            bond,
            bond / 5,
            2 hours,
            7 days,
            7 days
        );
        address proposer = makeAddr("bonded proposer");
        deal(address(bondToken), proposer, 2 * bond);
        vm.prank(proposer);
        bondToken.approve(address(resolver_), 2 * bond);

        uint64 announcesAt = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 figureEvent = registry.seal(_sealable(announcesAt, "a figure"));
        bytes32 invalidEvent = registry.seal(_sealable(announcesAt, "no figure"));

        vm.warp(announcesAt);
        assertEq(bondToken.balanceOf(address(resolver_)), 0);
        vm.prank(proposer);
        resolver_.proposeFigure(figureEvent, 125, 2);
        _record("OptimisticResolver.proposeFigure the resolver's first bond", "");

        vm.warp(vm.getBlockTimestamp() + 2 hours);
        assertEq(resolver_.owed(proposer), 0);
        resolver_.settle(figureEvent);
        _record("OptimisticResolver.settle a figure, the proposer's first credit", "");

        vm.warp(uint256(announcesAt) + 8 days + 1);
        vm.prank(proposer);
        resolver_.proposeInvalid(invalidEvent);
        _record("OptimisticResolver.proposeInvalid after the deadline", "");

        vm.warp(vm.getBlockTimestamp() + 2 hours);
        resolver_.settle(invalidEvent);
        assertEq(bondToken.balanceOf(proposer), 0);
        vm.prank(proposer);
        resolver_.withdraw();
        _record("OptimisticResolver.withdraw two bonds, to a proposer with nothing", "");
    }

    /// @notice The CRE receiver: a report delivered by its forwarder, proposing with the resolver's
    ///         first bond; its settled bond swept to a treasury holding nothing; and the treasury
    ///         recovering the balance kept for bonds. This contract is the forwarder, so each call is
    ///         the receiver's own cost, without a forwarder's.
    function test_creProposer() public {
        IERC20 bondToken = dollarVault.COLLATERAL();
        uint256 bond = 10 ** IERC20Metadata(address(bondToken)).decimals();
        OptimisticResolver resolver_ = new OptimisticResolver(
            factory,
            registry,
            address(this),
            address(this),
            bondToken,
            bond,
            bond / 5,
            2 hours,
            7 days,
            7 days
        );
        address owner = makeAddr("workflow owner");
        address treasury = makeAddr("treasury");
        CreProposer receiver =
            new CreProposer(address(this), resolver_, owner, "a1b2c3d4e5", treasury);
        deal(address(bondToken), address(receiver), 2 * bond);
        uint64 announcesAt = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 figureEvent = registry.seal(_sealable(announcesAt, "a reported figure"));
        bytes memory metadata = abi.encodePacked(
            keccak256("a workflow id"), bytes10("a1b2c3d4e5"), owner, bytes2(0x0001)
        );
        bytes memory report = abi.encode(figureEvent, int256(3342), uint8(2));

        vm.warp(announcesAt);
        assertEq(bondToken.balanceOf(address(resolver_)), 0);
        receiver.onReport(metadata, report);
        _record("CreProposer.onReport a figure, the resolver's first bond", "");

        vm.warp(vm.getBlockTimestamp() + 2 hours);
        resolver_.settle(figureEvent);
        assertEq(bondToken.balanceOf(treasury), 0);
        receiver.sweep();
        _record("CreProposer.sweep a settled bond, to a treasury holding nothing", "");

        vm.prank(treasury);
        receiver.recover(bondToken, bond);
        _record("CreProposer.recover the balance kept for bonds", "");
    }

    /// @notice A ruling's reason at its maximum length, so the measured rulings are the costliest.
    /// @param resolver_ The resolver whose maximum it is.
    /// @return The reason.
    function _longestReason(OptimisticResolver resolver_) internal view returns (string memory) {
        bytes memory reason = new bytes(resolver_.MAX_REASON());
        for (uint256 i = 0; i < reason.length; i++) {
            reason[i] = "r";
        }
        return string(reason);
    }

    /// @notice Disputes and rulings, each in its worst case: a first dispute that resets an event, a
    ///         second that sends it to the arbiter, and the arbiter's three rulings, each with a reason
    ///         of the longest length allowed.
    function test_disputes() public {
        IERC20 bondToken = dollarVault.COLLATERAL();
        uint256 bond = 10 ** IERC20Metadata(address(bondToken)).decimals();
        OptimisticResolver resolver_ = new OptimisticResolver(
            factory,
            registry,
            address(this),
            address(this),
            bondToken,
            bond,
            bond / 5,
            2 hours,
            7 days,
            7 days
        );
        address[3] memory parties =
            [makeAddr("first proposer"), makeAddr("disputer"), makeAddr("second proposer")];
        for (uint256 i = 0; i < 3; i++) {
            deal(address(bondToken), parties[i], 10 * bond);
            vm.prank(parties[i]);
            bondToken.approve(address(resolver_), 10 * bond);
        }
        uint64 announcesAt = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 ruledByFigure = registry.seal(_sealable(announcesAt, "ruled by figure"));
        bytes32 ruledInvalid = registry.seal(_sealable(announcesAt, "ruled invalid"));
        vm.warp(announcesAt);

        _escalate(resolver_, ruledByFigure, parties, true);
        resolver_.ruleContest(ruledByFigure, true, _longestReason(resolver_));
        _record("OptimisticResolver.ruleContest the first contest of an event", "");
        resolver_.ruleFigure(ruledByFigure, 125, 2, false, _longestReason(resolver_));
        _record("OptimisticResolver.ruleFigure a disputed second proposal", "");

        _escalate(resolver_, ruledInvalid, parties, false);
        vm.warp(uint256(announcesAt) + 8 days + 1);
        resolver_.ruleInvalid(ruledInvalid, false, _longestReason(resolver_));
        _record("OptimisticResolver.ruleInvalid a disputed second proposal, after the deadline", "");
    }

    /// @notice The exits anyone may take: expiring an event nobody resolved, expiring one the arbiter
    ///         left, and releasing a first contest the arbiter never ruled.
    function test_timeouts() public {
        IERC20 bondToken = dollarVault.COLLATERAL();
        uint256 bond = 10 ** IERC20Metadata(address(bondToken)).decimals();
        OptimisticResolver resolver_ = new OptimisticResolver(
            factory,
            registry,
            address(this),
            address(this),
            bondToken,
            bond,
            bond / 5,
            2 hours,
            7 days,
            7 days
        );
        address[3] memory parties =
            [makeAddr("first proposer"), makeAddr("disputer"), makeAddr("second proposer")];
        for (uint256 i = 0; i < 3; i++) {
            deal(address(bondToken), parties[i], 10 * bond);
            vm.prank(parties[i]);
            bondToken.approve(address(resolver_), 10 * bond);
        }
        uint64 announcesAt = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 unresolved = registry.seal(_sealable(announcesAt, "nobody resolves it"));
        bytes32 silent = registry.seal(_sealable(announcesAt, "the arbiter is silent"));
        vm.warp(announcesAt);
        _escalate(resolver_, silent, parties, false);

        vm.warp(resolver_.expiresAt(unresolved) + 1);
        resolver_.expire(unresolved);
        _record("OptimisticResolver.expire an event nobody resolved", "");

        vm.warp(resolver_.outcomeTimeout(silent));
        resolver_.expire(silent);
        _record("OptimisticResolver.expire an event the arbiter left, returning both bonds", "");

        resolver_.release(silent);
        _record("OptimisticResolver.release a first contest the arbiter never ruled", "");
    }

    /// @notice Proposes, disputes, proposes again and disputes again, recording both disputes once.
    /// @param resolver_ The resolver.
    /// @param id The event.
    /// @param parties The first proposer, the disputer and the second proposer.
    /// @param recordDisputes Whether to record the two disputes.
    function _escalate(
        OptimisticResolver resolver_,
        bytes32 id,
        address[3] memory parties,
        bool recordDisputes
    ) internal {
        vm.prank(parties[0]);
        resolver_.proposeFigure(id, 125, 2);
        vm.prank(parties[1]);
        resolver_.dispute(id, 0);
        if (recordDisputes) {
            _record("OptimisticResolver.dispute a first proposal, resetting the event", "");
        }
        vm.prank(parties[2]);
        resolver_.proposeFigure(id, 120, 2);
        vm.prank(parties[1]);
        resolver_.dispute(id, 1);
        if (recordDisputes) {
            _record("OptimisticResolver.dispute a second proposal, to the arbiter", "");
        }
    }

    /// @notice A threshold of 1.23, due at a given instant, with a deadline eight days later.
    /// @param announcesAt When the figure may be public.
    /// @param terms Its terms.
    /// @return The threshold.
    function _sealable(uint64 announcesAt, bytes memory terms)
        internal
        pure
        returns (ThresholdRegistry.Threshold memory)
    {
        return ThresholdRegistry.Threshold({
            value: 123,
            decimals: 2,
            announcesAt: announcesAt,
            deadline: announcesAt + 8 days,
            terms: terms
        });
    }

    /// @notice Registering a market's three pools with the freeze hook, then the guardian bringing
    ///         their freeze forward. The case builds its own resolver, sealed event and market, so
    ///         the fixture every other case measures is unchanged.
    /// @dev Neither call reaches the pool manager, so the hook is given a placeholder for it.
    function test_freezeHook() public {
        IERC20 underlying = underlyingVault.COLLATERAL();
        IERC20 dollar = dollarVault.COLLATERAL();
        OptimisticResolver resolver_ = new OptimisticResolver(
            factory, registry, address(this), address(this), dollar, 1, 1, 1, 1, 1
        );
        address hookAddress =
            address(uint160(0x4444 << 144) | Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        deployCodeTo(
            "FreezeHook.sol:FreezeHook",
            abi.encode(IPoolManager(address(0xdead)), resolver_, address(this)),
            hookAddress
        );
        FreezeHook hook = FreezeHook(hookAddress);
        bytes32 eventId =
            registry.seal(_sealable(uint64(vm.getBlockTimestamp() + 1 days), "frozen"));
        bytes32 marketId = factory.createMarket(
            underlying, dollar, eventId, address(resolver_), type(uint256).max, type(uint256).max
        );
        (PositionVault underlyingVault_, PositionVault dollarVault_) = factory.markets(marketId);
        (PoolKey memory yes,) =
            ConditionalPools.keysOf(underlyingVault_, dollarVault_, IHooks(hookAddress));
        assertEq(hook.freezesAt(yes.toId()), 0);

        hook.register(marketId, eventId);
        _record("FreezeHook.register a market's three pools", "");

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        hook.freezeNow(marketId);
        _record("FreezeHook.freezeNow a market's three pools", "");
    }

    /// @notice Entering a position through the router: in the yes world for a recipient holding no
    ///         legs (the worst case) and again for the same recipient (the steady one), and in the no
    ///         world for a fresh recipient. The case builds its own hook, market and seeded pools, so
    ///         the fixture every other case measures is unchanged.
    function test_positionRouter() public {
        (PositionRouter router, bytes32 marketId, PositionVault shares, PositionVault dollars) =
            _routerMarket();
        uint256 amount = 100 * 10 ** Metadata(address(dollars.COLLATERAL())).decimals();
        address payer = makeAddr("router payer");
        _fund(dollars, payer, 3 * amount);
        // Read first: a prank is spent on the first call, and a view call in the same statement is one.
        IERC20 dollar = dollars.COLLATERAL();
        vm.prank(payer);
        dollar.approve(address(router), 3 * amount);
        address first = makeAddr("first recipient");
        address second = makeAddr("second recipient");

        assertEq(shares.YES().balanceOf(first) + dollars.NO().balanceOf(first), 0);
        vm.prank(payer);
        router.enter(marketId, true, amount, 1, first, vm.getBlockTimestamp());
        _record("PositionRouter.enter the yes world, a recipient holding no legs", "");

        vm.prank(payer);
        router.enter(marketId, true, amount, 1, first, vm.getBlockTimestamp());
        _record("PositionRouter.enter the yes world, a recipient holding both legs", "");

        assertEq(shares.NO().balanceOf(second) + dollars.YES().balanceOf(second), 0);
        vm.prank(payer);
        router.enter(marketId, false, amount, 1, second, vm.getBlockTimestamp());
        _record("PositionRouter.enter the no world, a recipient holding no legs", "");
    }

    /// @notice Exiting a yes position to a recipient holding nothing: without levelling (the
    ///         surplus no-dollars come back) and levelled (almost all of it comes back as dollars).
    function test_positionRouterExit() public {
        (PositionRouter router, bytes32 marketId,, PositionVault dollars) = _routerMarket();
        uint256 amount = 100 * 10 ** Metadata(address(dollars.COLLATERAL())).decimals();
        (address holder, uint256 first, uint256 second) = _twoPositions(router, marketId, amount);

        address plain = makeAddr("plain exit recipient");
        PositionRouter.ExitOrder memory order = PositionRouter.ExitOrder({
            marketId: marketId,
            yes: true,
            shares: first,
            kept: amount,
            minOut: 1,
            levelSellsWorldDollar: false,
            level: 0,
            minLevelOut: 0,
            recipient: plain,
            deadline: vm.getBlockTimestamp()
        });
        assertEq(dollars.COLLATERAL().balanceOf(plain) + dollars.NO().balanceOf(plain), 0);
        vm.prank(holder);
        uint256 back = router.exit(order);
        _record("PositionRouter.exit the yes world, not levelled", "");

        // Without a level the dollars back are the shares' sale, so the surplus is what is left of
        // the kept leg; selling about this much of it levels the two at a yes-dollar of 0.6.
        (order.shares, order.recipient) = (second, makeAddr("levelled exit recipient"));
        (order.level, order.minLevelOut) = ((amount - back) * 1000 / 1665, 1);
        vm.prank(holder);
        router.exit(order);
        _record("PositionRouter.exit the yes world, levelled", "");
    }

    /// @notice A holder who entered the yes world twice and allowed the router both positions.
    /// @param router The router.
    /// @param marketId The market.
    /// @param amount The dollars of each entry.
    /// @return holder The holder.
    /// @return first The shares of the first entry.
    /// @return second The shares of the second.
    function _twoPositions(PositionRouter router, bytes32 marketId, uint256 amount)
        internal
        returns (address holder, uint256 first, uint256 second)
    {
        (PositionVault shares, PositionVault dollars) = factory.markets(marketId);
        holder = makeAddr("router holder");
        _fund(dollars, holder, 2 * amount);
        IERC20 dollar = dollars.COLLATERAL();
        IERC20 shareLeg = IERC20(address(shares.YES()));
        IERC20 keptLeg = IERC20(address(dollars.NO()));
        vm.startPrank(holder);
        dollar.approve(address(router), 2 * amount);
        first = router.enter(marketId, true, amount, 1, holder, vm.getBlockTimestamp());
        second = router.enter(marketId, true, amount, 1, holder, vm.getBlockTimestamp());
        shareLeg.approve(address(router), first + second);
        keptLeg.approve(address(router), 2 * amount);
        vm.stopPrank();
    }

    /// @notice A sealed, registered market over the fixture's collaterals, its yes and no pools open
    ///         at 1,040 and 960 dollars a share and seeded a fifth either side, and a router over it.
    /// @return router The router.
    /// @return marketId The market.
    /// @return shares Its vault over the underlying.
    /// @return dollars Its vault over the dollar.
    function _routerMarket()
        internal
        returns (
            PositionRouter router,
            bytes32 marketId,
            PositionVault shares,
            PositionVault dollars
        )
    {
        IPoolManager manager = _manager();
        OptimisticResolver resolver_ = new OptimisticResolver(
            factory, registry, address(this), address(this), dollarVault.COLLATERAL(), 1, 1, 1, 1, 1
        );
        address hookAddress =
            address(uint160(0x4444 << 144) | Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        deployCodeTo(
            "FreezeHook.sol:FreezeHook", abi.encode(manager, resolver_, address(this)), hookAddress
        );
        FreezeHook hook = FreezeHook(hookAddress);
        bytes32 eventId =
            registry.seal(_sealable(uint64(vm.getBlockTimestamp() + 1 days), "routed"));
        marketId = factory.createMarket(
            underlyingVault.COLLATERAL(),
            dollarVault.COLLATERAL(),
            eventId,
            address(resolver_),
            type(uint256).max,
            type(uint256).max
        );
        hook.register(marketId, eventId);
        (shares, dollars) = factory.markets(marketId);
        PoolModifyLiquidityTest seeder = new PoolModifyLiquidityTest(manager);
        _fund(shares, address(this), 100 * 10 ** Metadata(address(shares.COLLATERAL())).decimals());
        _fund(
            dollars,
            address(this),
            200_000 * 10 ** Metadata(address(dollars.COLLATERAL())).decimals()
        );
        PositionVault[2] memory vaults = [shares, dollars];
        for (uint256 index = 0; index < 2; index++) {
            IERC20 collateral = vaults[index].COLLATERAL();
            uint256 held = collateral.balanceOf(address(this));
            collateral.approve(address(vaults[index]), held);
            vaults[index].splitPosition(held);
            vaults[index].YES().approve(address(seeder), type(uint256).max);
            vaults[index].NO().approve(address(seeder), type(uint256).max);
        }
        _seedRouterPools(manager, seeder, shares, dollars, hookAddress);
        router = new PositionRouter(hook);
    }

    /// @notice Opens and seeds a market's three pools: the yes and no pools at 1,040 and 960 dollars
    ///         a share, the probability pool at a yes-dollar of 0.6.
    /// @param manager The pool manager.
    /// @param seeder The liquidity router.
    /// @param shares The vault over the underlying.
    /// @param dollars The vault over the dollar.
    /// @param hookAddress The freeze hook.
    function _seedRouterPools(
        IPoolManager manager,
        PoolModifyLiquidityTest seeder,
        PositionVault shares,
        PositionVault dollars,
        address hookAddress
    ) internal {
        (PoolKey memory yes, PoolKey memory no) =
            ConditionalPools.keysOf(shares, dollars, IHooks(hookAddress));
        _seedPool(
            manager,
            seeder,
            yes,
            ConditionalPools.sqrtPriceX96(yes, Metadata(address(shares.YES())), 1040, 0),
            1e16
        );
        _seedPool(
            manager,
            seeder,
            no,
            ConditionalPools.sqrtPriceX96(no, Metadata(address(shares.NO())), 960, 0),
            1e16
        );
        _seedPool(
            manager,
            seeder,
            ConditionalPools.probabilityKeyOf(dollars, IHooks(hookAddress)),
            ConditionalPools.sqrtPriceAtYesDollarPrice(dollars, 0.6e18),
            1e11
        );
    }

    /// @notice Opens a pool at a price and seeds it a fifth either side.
    /// @param manager The pool manager.
    /// @param seeder The liquidity router.
    /// @param key The pool.
    /// @param sqrtPriceX96 Its opening price.
    /// @param liquidity The position's liquidity.
    function _seedPool(
        IPoolManager manager,
        PoolModifyLiquidityTest seeder,
        PoolKey memory key,
        uint160 sqrtPriceX96,
        uint128 liquidity
    ) internal {
        int24 tick = manager.initialize(key, sqrtPriceX96);
        int24 lower = (tick - 1823) / 60 * 60 - 60;
        int24 upper = (tick + 1823) / 60 * 60 + 60;
        seeder.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams(
                lower, upper, SafeCast.toInt256(uint256(liquidity)), 0
            ),
            ""
        );
    }

    /// @notice A resolver's first report of a condition.
    function test_reportOutcome() public {
        assertEq(uint8(factory.outcomeOf(underlyingVault.CONDITION())), uint8(Outcome.Unresolved));
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);
        _record("MarketFactory.reportOutcome first report of a condition", "");
    }

    /// @notice The first split in a vault, by a holder with no legs and an exact allowance; then a
    ///         further split by the same holder.
    function test_splitPosition() public {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        for (uint256 index = 0; index < 2; index++) {
            PositionVault vault = vaults[index];
            string memory name = _name(vault);
            IERC20 collateral = vault.COLLATERAL();
            uint256 amount = _amount(vault);
            address holder = makeAddr(string.concat("splitter ", name));
            _fund(vault, holder, 2 * amount);
            vm.prank(holder);
            collateral.approve(address(vault), amount);

            assertEq(vault.YES().totalSupply() + vault.NO().totalSupply(), 0);
            assertEq(vault.YES().balanceOf(holder) + vault.NO().balanceOf(holder), 0);
            assertEq(collateral.balanceOf(address(vault)), 0);
            assertEq(collateral.allowance(holder, address(vault)), amount);
            vm.prank(holder);
            vault.splitPosition(amount);
            _record("PositionVault.splitPosition first in the vault, exact allowance, ", name);

            vm.prank(holder);
            collateral.approve(address(vault), amount);
            vm.prank(holder);
            vault.splitPosition(amount);
            _record("PositionVault.splitPosition again by the same holder, exact allowance, ", name);
        }
    }

    /// @notice Everything back to a holder left with no collateral; then part back to a holder with
    ///         a balance.
    function test_mergePositions() public {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        for (uint256 index = 0; index < 2; index++) {
            PositionVault vault = vaults[index];
            string memory name = _name(vault);
            uint256 amount = _amount(vault);
            address emptied = _split(vault, "emptied", amount, amount);
            address holding = _split(vault, "holding", 2 * amount, amount);

            assertEq(vault.COLLATERAL().balanceOf(emptied), 0);
            vm.prank(emptied);
            vault.mergePositions(amount);
            _record(
                "PositionVault.mergePositions everything, to a holder with no collateral, ", name
            );

            vm.prank(holding);
            vault.mergePositions(amount / 2);
            _record("PositionVault.mergePositions part, to a holder with collateral, ", name);
        }
    }

    /// @notice Both legs to a holder with no collateral; then the winning leg alone to a holder with
    ///         a balance.
    function test_redeemPositions() public {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        address[2] memory emptied;
        address[2] memory holding;
        for (uint256 index = 0; index < 2; index++) {
            uint256 amount = _amount(vaults[index]);
            emptied[index] = _split(vaults[index], "redeemer, emptied", amount, amount);
            holding[index] = _split(vaults[index], "redeemer, holding", 2 * amount, amount);
        }
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);

        for (uint256 index = 0; index < 2; index++) {
            PositionVault vault = vaults[index];
            string memory name = _name(vault);
            uint256 amount = _amount(vault);
            assertEq(vault.COLLATERAL().balanceOf(emptied[index]), 0);
            vm.prank(emptied[index]);
            vault.redeemPositions(amount, amount);
            _record(
                "PositionVault.redeemPositions both legs, to a holder with no collateral, ", name
            );

            vm.prank(holding[index]);
            vault.redeemPositions(amount, 0);
            _record(
                "PositionVault.redeemPositions the winning leg, to a holder with collateral, ", name
            );
        }
    }

    /// @notice A leg moved by its holder, by a spender, and an allowance granted.
    function test_legs() public {
        uint256 amount = _amount(underlyingVault);
        address holder = _split(underlyingVault, "leg holder", amount, amount);
        IERC20 leg = underlyingVault.YES();
        address stranger = makeAddr("no legs");
        address other = makeAddr("another holder");
        address spender = makeAddr("spender");
        address unlimited = makeAddr("unlimited spender");

        assertEq(leg.balanceOf(stranger), 0);
        vm.prank(holder);
        leg.transfer(stranger, amount / 8);
        _record("PositionToken.transfer to an address with no legs", "");

        vm.prank(holder);
        leg.transfer(stranger, amount / 8);
        _record("PositionToken.transfer to a holder", "");

        assertEq(leg.allowance(holder, spender), 0);
        vm.prank(holder);
        leg.approve(spender, amount / 8);
        _record("PositionToken.approve a fresh allowance", "");

        assertEq(leg.balanceOf(other), 0);
        vm.prank(spender);
        leg.transferFrom(holder, other, amount / 8);
        _record("PositionToken.transferFrom exact allowance, to an address with no legs", "");

        vm.prank(holder);
        leg.approve(unlimited, type(uint256).max);
        vm.prank(unlimited);
        leg.transferFrom(holder, other, amount / 8);
        _record("PositionToken.transferFrom unlimited allowance, to a holder", "");
    }

    /// @notice The test network's tokens, price feed and report probe: what a visitor, the owner, the
    ///         publisher and a forwarder pay there. Recorded on the test network's chain id, the only one they deploy on.
    function test_testnet() public {
        vm.chainId(10_143);
        address owner = makeAddr("test network owner");
        TestnetDollar dollar = new TestnetDollar(owner);
        TestnetStock stock = new TestnetStock("Tesla test stock", "TSLA", owner);
        _tokenCases(dollar, "TestnetDollar");
        _tokenCases(stock, "TestnetStock");

        TestnetStockOracle oracle = new TestnetStockOracle(owner);
        TestnetStockOracle.Post[] memory posts = new TestnetStockOracle.Post[](10);
        string[10] memory symbols =
            ["TSLA", "META", "HOOD", "MSFT", "GOOGL", "AAPL", "AMD", "NVDA", "WMT", "MU"];
        for (uint256 i = 0; i < posts.length; ++i) {
            posts[i] = TestnetStockOracle.Post({
                priceId: keccak256(bytes(symbols[i])),
                price: SafeCast.toInt128(SafeCast.toInt256(100e8 + i)),
                bestBid: SafeCast.toInt128(SafeCast.toInt256(99e8 + i)),
                bestAsk: SafeCast.toInt128(SafeCast.toInt256(101e8 + i)),
                feedUpdateTimestamp: SafeCast.toUint64(vm.getBlockTimestamp())
            });
        }
        vm.expectRevert();
        oracle.latestPrice(posts[0].priceId);
        vm.prank(owner);
        oracle.post(posts);
        _record("TestnetStockOracle.post ten symbols, each one's first round", "");
        vm.prank(owner);
        oracle.post(posts);
        _record("TestnetStockOracle.post ten symbols, a later round", "");

        TestnetReportProbe probe = new TestnetReportProbe(owner);
        bytes memory metadata = abi.encodePacked(
            keccak256("workflow"), bytes10("1a2b3c4d5e"), makeAddr("workflow owner"), bytes2(0x0001)
        );
        probe.onReport(metadata, abi.encode(keccak256("event"), int256(43), uint8(2)));
        _record("TestnetReportProbe.onReport a forwarder's delivery", "");
    }

    /// @notice One test token's cases: a drip, a mint, and its standard transfers.
    /// @param token The token.
    /// @param name Its contract's name, which the cases are recorded under.
    function _tokenCases(TestnetToken token, string memory name) internal {
        address visitor = makeAddr(string.concat(name, " visitor"));
        address stranger = makeAddr(string.concat(name, " stranger"));
        address spender = makeAddr(string.concat(name, " spender"));

        assertEq(token.lastDrip(visitor), 0);
        vm.prank(visitor);
        token.drip();
        _record(string.concat(name, ".drip a first drip"), "");
        vm.warp(vm.getBlockTimestamp() + token.COOLDOWN());
        vm.prank(visitor);
        token.drip();
        _record(string.concat(name, ".drip again, after the cooldown"), "");

        assertEq(token.balanceOf(stranger), 0);
        address owner = token.OWNER();
        uint256 one = token.DRIP();
        vm.prank(owner);
        token.mint(stranger, one);
        _record(string.concat(name, ".mint to an address holding none"), "");

        uint256 amount = token.DRIP() / 4;
        address other = makeAddr(string.concat(name, " other"));
        vm.prank(visitor);
        token.transfer(other, amount);
        _record(string.concat(name, ".transfer to an address holding none"), "");
        vm.prank(visitor);
        token.approve(spender, amount);
        _record(string.concat(name, ".approve a fresh allowance"), "");
        address third = makeAddr(string.concat(name, " third"));
        vm.prank(spender);
        token.transferFrom(visitor, third, amount);
        _record(
            string.concat(name, ".transferFrom exact allowance, to an address holding none"), ""
        );
    }

    /// @notice A holder who has split into a vault.
    /// @param vault The vault.
    /// @param label Names the holder.
    /// @param funded How much collateral the holder starts with.
    /// @param amount How much the holder splits.
    /// @return holder The holder.
    function _split(PositionVault vault, string memory label, uint256 funded, uint256 amount)
        internal
        returns (address holder)
    {
        holder = makeAddr(string.concat(label, " ", _name(vault)));
        _fund(vault, holder, funded);
        vm.startPrank(holder);
        vault.COLLATERAL().approve(address(vault), amount);
        vault.splitPosition(amount);
        vm.stopPrank();
    }

    /// @notice Gives an account collateral.
    /// @dev The balance is fabricated with the storage cheatcode; nothing here reads the supply.
    /// @param vault The vault whose collateral to give.
    /// @param to The account.
    /// @param amount How much.
    function _fund(PositionVault vault, address to, uint256 amount) internal {
        deal(address(vault.COLLATERAL()), to, amount);
    }

    /// @notice One whole unit of a vault's collateral.
    /// @param vault The vault.
    /// @return The amount.
    function _amount(PositionVault vault) internal view returns (uint256) {
        return 10 ** IERC20Metadata(address(vault.COLLATERAL())).decimals();
    }

    /// @notice A vault's collateral by symbol.
    /// @param vault The vault.
    /// @return The symbol.
    function _name(PositionVault vault) internal view returns (string memory) {
        return IERC20Metadata(address(vault.COLLATERAL())).symbol();
    }

    /// @notice Records the last call's gas under a case.
    /// @dev Makes no call of its own: everything it records is computed before the measured call.
    /// @param case_ The case.
    /// @param suffix Appended to it.
    function _record(string memory case_, string memory suffix) internal {
        vm.snapshotGasLastFrame(_group(), string.concat(case_, suffix));
    }
}

/// @title GasBudgetsTest
/// @notice The cases over test collaterals: regression budgets for this repository's own code.
contract GasBudgetsTest is GasCases {
    /// @notice The file the values are recorded in.
    /// @return The group: budgets.
    function _group() internal pure override returns (string memory) {
        return "budgets";
    }

    /// @notice The two collaterals the market is created over.
    /// @return The underlying.
    /// @return The dollar.
    function _collaterals() internal override returns (IERC20, IERC20) {
        return (IERC20(address(new TestStock())), IERC20(address(new TestCollateral())));
    }

    /// @notice A fresh local pool manager.
    /// @return The manager.
    function _manager() internal override returns (IPoolManager) {
        return new PoolManager(address(this));
    }
}
