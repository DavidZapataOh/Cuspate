// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {FreezeHook} from "../../src/FreezeHook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {TestCollateral} from "./PositionVault.t.sol";
import {TestStock} from "./MarketFactory.t.sol";

/// @notice A market resolved by a real resolver, its event sealed by that resolver's sealer, and the
///         freeze hook placed at an address whose low bits enable exactly its two callbacks, over a
///         local pool manager. Shared by the unit and fuzz tests of the hook.
abstract contract FreezeHookSetup is Test {
    using PoolIdLibrary for PoolKey;

    /// @notice The hook's address: its low fourteen bits carry exactly the before-initialise and
    ///         before-swap permissions.
    address internal constant HOOK =
        address(uint160(0x4444 << 144) | Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    /// @notice When the event's figure may first be public, relative to the start of the test.
    uint64 internal constant LEAD = 1 days;

    address internal sealer = makeAddr("sealer");
    address internal guardian = makeAddr("guardian");

    IPoolManager internal manager;
    MarketFactory internal factory;
    ThresholdRegistry internal registry;
    OptimisticResolver internal resolver;
    FreezeHook internal hook;
    PoolSwapTest internal swapRouter;

    IERC20 internal underlying;
    IERC20 internal dollar;
    bytes32 internal eventId;
    uint64 internal announcesAt;
    bytes32 internal marketId;
    PoolKey internal yesKey;
    PoolKey internal noKey;
    PoolKey internal probabilityKey;

    /// @notice A sealed event, a market on it with the canonical resolver, and the hook.
    function setUp() public virtual {
        manager = new PoolManager(address(this));
        factory = new MarketFactory();
        registry = new ThresholdRegistry();
        resolver = new OptimisticResolver(
            factory, registry, sealer, makeAddr("arbiter"), IERC20(address(1)), 1, 1, 1, 1, 1
        );
        deployCodeTo("FreezeHook.sol:FreezeHook", abi.encode(manager, resolver, guardian), HOOK);
        hook = FreezeHook(HOOK);
        swapRouter = new PoolSwapTest(manager);

        underlying = IERC20(address(new TestStock()));
        dollar = IERC20(address(new TestCollateral()));
        announcesAt = uint64(vm.getBlockTimestamp()) + LEAD;
        eventId = _seal(sealer, announcesAt);
        marketId = factory.createMarket(underlying, dollar, eventId, address(resolver));
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(marketId);
        (yesKey, noKey) = ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(HOOK));
        probabilityKey = ConditionalPools.probabilityKeyOf(dollarVault, IHooks(HOOK));
    }

    /// @notice Seals a threshold as `by`, announced at `at`.
    /// @param by Who seals it.
    /// @param at When its figure may first be public.
    /// @return The event's id.
    function _seal(address by, uint64 at) internal returns (bytes32) {
        vm.prank(by);
        return registry.seal(
            ThresholdRegistry.Threshold({
                value: 1, decimals: 0, announcesAt: at, deadline: at + 1 days, terms: "t"
            })
        );
    }

    /// @notice The market's three pools.
    /// @return keys Yes, no and probability.
    function _keys() internal view returns (PoolKey[3] memory keys) {
        keys = [yesKey, noKey, probabilityKey];
    }

    /// @notice A swap of one raw unit against no liquidity: it moves nothing and owes nothing, so it
    ///         reaches the hook with no funds involved.
    /// @param key The pool.
    /// @param zeroForOne The direction.
    function _swap(PoolKey memory key, bool zeroForOne) internal {
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -1,
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @notice What a caller of the pool manager sees when the hook refuses: the hook's own error
    ///         inside the manager's wrapper.
    /// @param selector The callback that refused.
    /// @param reason The hook's error.
    /// @return The wrapped error.
    function _wrapped(bytes4 selector, bytes memory reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            HOOK,
            selector,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    /// @notice The refusal of a swap or an initialisation at a frozen pool.
    /// @param selector The callback.
    /// @param key The pool.
    /// @param at Its freeze instant.
    /// @return The wrapped error.
    function _frozen(bytes4 selector, PoolKey memory key, uint64 at)
        internal
        pure
        returns (bytes memory)
    {
        return
            _wrapped(selector, abi.encodeWithSelector(FreezeHook.Frozen.selector, key.toId(), at));
    }
}

/// @title FreezeHookTest
/// @notice Registration copies on-chain facts and nothing else; only a registered market's three
///         canonical pools can be opened with the hook; their swaps stop at the sealed instant and
///         never resume; and the guardian can only bring that instant forward.
contract FreezeHookTest is FreezeHookSetup {
    using PoolIdLibrary for PoolKey;

    /// @notice A zero address is refused for each constructor argument. Listed first: the coverage
    ///         tool drops hits from the last expected-revert creation in a test.
    function test_RevertWhen_aConstructorArgumentIsZero() public {
        vm.expectRevert(FreezeHook.ZeroAddress.selector);
        new FreezeHook(IPoolManager(address(0)), resolver, guardian);
        vm.expectRevert(FreezeHook.ZeroAddress.selector);
        new FreezeHook(manager, OptimisticResolver(address(0)), guardian);
        vm.expectRevert(FreezeHook.ZeroAddress.selector);
        new FreezeHook(manager, resolver, address(0));
        assertEq(address(hook.GUARDIAN()), guardian);
    }

    /// @notice A hook deployed where its address does not carry exactly its two permissions refuses
    ///         to exist, so no pool can be keyed to a hook the manager would call differently.
    function test_RevertWhen_theAddressCarriesOtherPermissions() public {
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, next));
        new FreezeHook(manager, resolver, guardian);
        assertEq(address(hook.POOL_MANAGER()), address(manager));
    }

    /// @notice The hook reads the factory, registry and sealer from the resolver it serves, so it can
    ///         never pair one factory with another's resolver.
    function test_theHookReadsItsFactsFromTheResolver() public view {
        assertEq(address(hook.RESOLVER()), address(resolver));
        assertEq(address(hook.FACTORY()), address(factory));
        assertEq(address(hook.REGISTRY()), address(registry));
        assertEq(hook.SEALER(), sealer);
    }

    /// @notice Registration writes the sealed instant for exactly the market's three pools, and
    ///         announces them.
    function test_registerWritesTheThreePools() public {
        vm.expectEmit(address(hook));
        emit FreezeHook.MarketRegistered(
            marketId, eventId, announcesAt, yesKey.toId(), noKey.toId(), probabilityKey.toId()
        );
        vm.prank(makeAddr("anyone"));
        assertEq(hook.register(underlying, dollar, eventId), marketId);
        PoolKey[3] memory keys = _keys();
        for (uint256 index = 0; index < 3; index++) {
            assertEq(hook.freezesAt(keys[index].toId()), announcesAt);
        }
    }

    /// @notice A market that does not exist with the canonical resolver is refused.
    function test_RevertWhen_theMarketDoesNotExist() public {
        bytes32 otherEvent = _seal(sealer, announcesAt + 1);
        bytes32 missing =
            factory.marketId(underlying, dollar, factory.condition(address(resolver), otherEvent));
        vm.expectRevert(abi.encodeWithSelector(FreezeHook.NotAMarket.selector, missing));
        hook.register(underlying, dollar, otherEvent);

        // The same event with another resolver is another market, which this hook does not serve.
        factory.createMarket(underlying, dollar, otherEvent, makeAddr("another resolver"));
        vm.expectRevert(abi.encodeWithSelector(FreezeHook.NotAMarket.selector, missing));
        hook.register(underlying, dollar, otherEvent);
    }

    /// @notice An event sealed by anyone but the resolver's sealer, or by nobody, never resolves, and
    ///         its market gets no pools.
    function test_RevertWhen_theEventIsNotSealedByTheSealer() public {
        address stranger = makeAddr("stranger");
        bytes32 foreign = _seal(stranger, announcesAt);
        factory.createMarket(underlying, dollar, foreign, address(resolver));
        vm.expectRevert(
            abi.encodeWithSelector(FreezeHook.NotSealedByTheSealer.selector, foreign, stranger)
        );
        hook.register(underlying, dollar, foreign);

        bytes32 unsealed = keccak256("never sealed");
        factory.createMarket(underlying, dollar, unsealed, address(resolver));
        vm.expectRevert(
            abi.encodeWithSelector(FreezeHook.NotSealedByTheSealer.selector, unsealed, address(0))
        );
        hook.register(underlying, dollar, unsealed);
    }

    /// @notice A market whose announcement has come is refused: its pools would be born frozen.
    function test_RevertWhen_theAnnouncementHasPassed() public {
        vm.warp(announcesAt);
        vm.expectRevert(
            abi.encodeWithSelector(FreezeHook.AnnouncementPassed.selector, eventId, announcesAt)
        );
        hook.register(underlying, dollar, eventId);
    }

    /// @notice A second registration writes nothing, so a front-run cannot break a launch and nobody
    ///         can undo a freeze the guardian brought forward.
    function test_aSecondRegistrationChangesNothing() public {
        hook.register(underlying, dollar, eventId);
        vm.warp(announcesAt - 100);
        vm.prank(guardian);
        hook.freezeNow(marketId);
        vm.recordLogs();
        assertEq(hook.register(underlying, dollar, eventId), marketId);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(hook.freezesAt(yesKey.toId()), announcesAt - 100);
    }

    /// @notice The canonical pools initialise; a key that differs in fee, spacing or pairing is
    ///         refused, as is a pool of an unregistered market.
    function test_onlyTheCanonicalPoolsInitialise() public {
        PoolKey memory stray = PoolKey(yesKey.currency0, yesKey.currency1, 500, 10, IHooks(HOOK));
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(FreezeHook.NotARegisteredPool.selector, yesKey.toId())
            )
        );
        manager.initialize(yesKey, uint160(1 << 96));

        hook.register(underlying, dollar, eventId);
        PoolKey[3] memory keys = _keys();
        for (uint256 index = 0; index < 3; index++) {
            manager.initialize(keys[index], uint160(1 << 96));
        }
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(FreezeHook.NotARegisteredPool.selector, stray.toId())
            )
        );
        manager.initialize(stray, uint160(1 << 96));
        PoolKey memory crossed = PoolKey(yesKey.currency0, noKey.currency1, 3000, 60, IHooks(HOOK));
        if (Currency.unwrap(crossed.currency0) > Currency.unwrap(crossed.currency1)) {
            crossed = PoolKey(noKey.currency1, yesKey.currency0, 3000, 60, IHooks(HOOK));
        }
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(FreezeHook.NotARegisteredPool.selector, crossed.toId())
            )
        );
        manager.initialize(crossed, uint160(1 << 96));
    }

    /// @notice A registered pool nobody opened before its instant can no longer be opened.
    function test_RevertWhen_aPoolIsInitialisedAfterItsFreeze() public {
        hook.register(underlying, dollar, eventId);
        vm.warp(announcesAt);
        vm.expectRevert(_frozen(IHooks.beforeInitialize.selector, yesKey, announcesAt));
        manager.initialize(yesKey, uint160(1 << 96));
    }

    /// @notice Swaps pass one second before the instant and are refused from it on, in every pool and
    ///         both directions, and still a week later.
    function test_swapsStopAtTheInstantAndNeverResume() public {
        hook.register(underlying, dollar, eventId);
        PoolKey[3] memory keys = _keys();
        for (uint256 index = 0; index < 3; index++) {
            manager.initialize(keys[index], uint160(1 << 96));
        }
        vm.warp(announcesAt - 1);
        for (uint256 index = 0; index < 3; index++) {
            _swap(keys[index], true);
            _swap(keys[index], false);
        }
        uint64[2] memory later = [announcesAt, announcesAt + 7 days];
        for (uint256 moment = 0; moment < 2; moment++) {
            vm.warp(later[moment]);
            for (uint256 index = 0; index < 3; index++) {
                vm.expectRevert(_frozen(IHooks.beforeSwap.selector, keys[index], announcesAt));
                _swap(keys[index], index % 2 == 0);
            }
        }
    }

    /// @notice Before the instant the hook changes nothing about a swap: no delta, no fee override.
    function test_anOpenSwapIsUntouched() public {
        hook.register(underlying, dollar, eventId);
        IPoolManager.SwapParams memory params =
            IPoolManager.SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1);
        vm.prank(address(manager));
        (bytes4 selector, BeforeSwapDelta delta, uint24 fee) =
            hook.beforeSwap(address(this), yesKey, params, "");
        assertEq(selector, IHooks.beforeSwap.selector);
        assertEq(BeforeSwapDelta.unwrap(delta), 0);
        assertEq(fee, 0);
        vm.prank(address(manager));
        assertEq(
            hook.beforeInitialize(address(this), yesKey, uint160(1 << 96)),
            IHooks.beforeInitialize.selector
        );
    }

    /// @notice The callbacks answer only the pool manager.
    function test_RevertWhen_aCallbackCallerIsNotThePoolManager() public {
        hook.register(underlying, dollar, eventId);
        vm.expectRevert(abi.encodeWithSelector(FreezeHook.NotPoolManager.selector, address(this)));
        hook.beforeInitialize(address(this), yesKey, uint160(1 << 96));
        IPoolManager.SwapParams memory params =
            IPoolManager.SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1);
        vm.expectRevert(abi.encodeWithSelector(FreezeHook.NotPoolManager.selector, address(this)));
        hook.beforeSwap(address(this), yesKey, params, "");
    }

    /// @notice The guardian brings all three instants forward to now, and swaps stop at once.
    function test_theGuardianFreezesAMarketNow() public {
        hook.register(underlying, dollar, eventId);
        manager.initialize(yesKey, uint160(1 << 96));
        uint64 now_ = announcesAt - 3600;
        vm.warp(now_);
        vm.expectEmit(address(hook));
        emit FreezeHook.FrozenEarly(marketId, now_, announcesAt);
        vm.prank(guardian);
        hook.freezeNow(marketId);
        PoolKey[3] memory keys = _keys();
        for (uint256 index = 0; index < 3; index++) {
            assertEq(hook.freezesAt(keys[index].toId()), now_);
        }
        vm.expectRevert(_frozen(IHooks.beforeSwap.selector, yesKey, now_));
        _swap(yesKey, true);
    }

    /// @notice A freeze already reached is never moved, earlier or later, and nothing is announced.
    function test_theGuardianNeverMovesAPassedFreeze() public {
        hook.register(underlying, dollar, eventId);
        vm.warp(announcesAt + 10);
        vm.recordLogs();
        vm.prank(guardian);
        hook.freezeNow(marketId);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(hook.freezesAt(yesKey.toId()), announcesAt);
    }

    /// @notice Only the guardian may bring a freeze forward.
    function test_RevertWhen_freezeNowCallerIsNotTheGuardian() public {
        hook.register(underlying, dollar, eventId);
        vm.expectRevert(abi.encodeWithSelector(FreezeHook.NotTheGuardian.selector, address(this)));
        hook.freezeNow(marketId);
    }

    /// @notice A market that was never registered, or never created, has nothing to freeze.
    function test_RevertWhen_freezeNowMarketIsNotRegistered() public {
        vm.expectRevert(abi.encodeWithSelector(FreezeHook.NotRegistered.selector, marketId));
        vm.prank(guardian);
        hook.freezeNow(marketId);
        bytes32 nowhere = keccak256("no such market");
        vm.expectRevert(abi.encodeWithSelector(FreezeHook.NotRegistered.selector, nowhere));
        vm.prank(guardian);
        hook.freezeNow(nowhere);
    }
}
