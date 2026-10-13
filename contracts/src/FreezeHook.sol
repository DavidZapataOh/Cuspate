// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {ConditionalPools} from "./ConditionalPools.sol";
import {MarketFactory} from "./MarketFactory.sol";
import {OptimisticResolver} from "./OptimisticResolver.sol";
import {PositionVault} from "./PositionVault.sol";
import {ThresholdRegistry} from "./ThresholdRegistry.sol";

/// @title FreezeHook
/// @notice The hook every pool of a market carries. A market's result is a jump that no block time
///         defends a liquidity provider against; only not trading through it does. So from the
///         instant its event's figure may first be public, as sealed, the market's three pools take
///         no swap, and they never take one again: holders redeem or merge instead. Liquidity is never
///         gated, so providers withdraw at any time.
/// @dev Only a registered market's three canonical pools can be opened with this hook. Registration
///      is open to anyone because it copies facts already on chain: the market, its event, and the
///      instant sealed for it. One named guardian may bring a market's freeze forward to now, for a
///      moved announcement or a failure with funds inside; nobody can move a freeze later or reopen
///      a pool. The hook holds no funds, returns no delta and never calls the pool manager: v4 skips
///      the callbacks of a hook that is itself the caller, so such a call would pass the freeze by.
contract FreezeHook {
    using PoolIdLibrary for PoolKey;

    /// @notice The pool manager whose pools carry this hook.
    IPoolManager public immutable POOL_MANAGER;

    /// @notice The resolver whose markets this hook serves.
    OptimisticResolver public immutable RESOLVER;

    /// @notice The factory the resolver reports into, read from it.
    MarketFactory public immutable FACTORY;

    /// @notice The registry the resolver reads its events from, read from it.
    ThresholdRegistry public immutable REGISTRY;

    /// @notice The only sealer whose events the resolver resolves, read from it.
    address public immutable SEALER;

    /// @notice Who may bring a market's freeze forward to now.
    address public immutable GUARDIAN;

    /// @notice The instant each registered pool stops taking swaps; zero for a pool that is not one.
    mapping(PoolId id => uint64 instant) public freezesAt;

    /// @notice Thrown when a constructor argument is the zero address.
    error ZeroAddress();

    /// @notice Thrown when a callback is called by anyone but the pool manager.
    /// @param caller Who called.
    error NotPoolManager(address caller);

    /// @notice Thrown when anyone but the guardian brings a freeze forward.
    /// @param caller Who called.
    error NotTheGuardian(address caller);

    /// @notice Thrown when no market with the canonical resolver exists for the arguments given.
    /// @param marketId The id they give.
    error NotAMarket(bytes32 marketId);

    /// @notice Thrown when an event is not sealed by the resolver's sealer: it can never resolve.
    /// @param eventId The event.
    /// @param sealer Who sealed it; zero if nobody did.
    error NotSealedByTheSealer(bytes32 eventId, address sealer);

    /// @notice Thrown when an event's announcement has already come: its pools would be born frozen.
    /// @param eventId The event.
    /// @param announcesAt Its sealed instant.
    error AnnouncementPassed(bytes32 eventId, uint64 announcesAt);

    /// @notice Thrown when the guardian names a market that was never registered.
    /// @param marketId The market.
    error NotRegistered(bytes32 marketId);

    /// @notice Thrown when a pool is opened that is not one of a registered market's three.
    /// @param id The pool.
    error NotARegisteredPool(PoolId id);

    /// @notice Thrown when a frozen pool is swapped in or opened.
    /// @param id The pool.
    /// @param instant When it froze.
    error Frozen(PoolId id, uint64 instant);

    /// @notice A market's three pools were registered, freezing at its sealed instant.
    /// @param marketId The market.
    /// @param eventId Its event.
    /// @param instant When its pools freeze.
    /// @param yesPool The pool of the yes legs.
    /// @param noPool The pool of the no legs.
    /// @param probabilityPool The pool of the dollar's two legs.
    event MarketRegistered(
        bytes32 indexed marketId,
        bytes32 indexed eventId,
        uint64 instant,
        PoolId yesPool,
        PoolId noPool,
        PoolId probabilityPool
    );

    /// @notice The guardian brought a market's freeze forward.
    /// @param marketId The market.
    /// @param instant When its pools now freeze.
    /// @param wasAt When they would have.
    event FrozenEarly(bytes32 indexed marketId, uint64 instant, uint64 wasAt);

    /// @notice Creates the hook for one resolver's markets. Its address must carry exactly the
    ///         before-initialise and before-swap permissions, or it refuses to exist.
    /// @param manager The pool manager.
    /// @param resolver The resolver whose markets it serves; its factory, registry and sealer are
    ///        read from it, so they can never disagree with it.
    /// @param guardian Who may bring a freeze forward.
    constructor(IPoolManager manager, OptimisticResolver resolver, address guardian) {
        if (
            address(manager) == address(0) || address(resolver) == address(0)
                || guardian == address(0)
        ) {
            revert ZeroAddress();
        }
        POOL_MANAGER = manager;
        RESOLVER = resolver;
        FACTORY = resolver.FACTORY();
        REGISTRY = resolver.REGISTRY();
        SEALER = resolver.SEALER();
        GUARDIAN = guardian;
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: false,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    /// @notice Registers a market's three pools, to freeze at its event's sealed instant. A market
    ///         already registered is left exactly as it is, so a registration sent first by someone
    ///         else breaks nothing and undoes nothing.
    /// @param underlying The market's underlying.
    /// @param dollar The market's dollar.
    /// @param eventId The event it is conditioned on.
    /// @return marketId The market.
    /// @custom:access anyone
    function register(IERC20 underlying, IERC20 dollar, bytes32 eventId)
        external
        returns (bytes32 marketId)
    {
        marketId = FACTORY.marketId(
            underlying, dollar, FACTORY.condition(address(RESOLVER), eventId)
        );
        (PositionVault underlyingVault, PositionVault dollarVault) = FACTORY.markets(marketId);
        if (address(underlyingVault) == address(0)) {
            revert NotAMarket(marketId);
        }
        (PoolId yesPool, PoolId noPool, PoolId probabilityPool) =
            _poolsOf(underlyingVault, dollarVault);
        if (freezesAt[yesPool] != 0) {
            return marketId;
        }
        // forge-lint: disable-next-line(unused-return)
        (address sealer,,,, uint64 announcesAt,) = REGISTRY.thresholdOf(eventId);
        if (sealer != SEALER) {
            revert NotSealedByTheSealer(eventId, sealer);
        }
        // The sealed instant is the freeze; a market past it has no trading life left to open.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= announcesAt) {
            revert AnnouncementPassed(eventId, announcesAt);
        }
        freezesAt[yesPool] = announcesAt;
        freezesAt[noPool] = announcesAt;
        freezesAt[probabilityPool] = announcesAt;
        emit MarketRegistered(marketId, eventId, announcesAt, yesPool, noPool, probabilityPool);
    }

    /// @notice Brings a registered market's freeze forward to now. A freeze already reached is left
    ///         as it is: nothing here can move one later or reopen a pool.
    /// @param marketId The market.
    /// @custom:access guardian
    function freezeNow(bytes32 marketId) external {
        if (msg.sender != GUARDIAN) {
            revert NotTheGuardian(msg.sender);
        }
        (PositionVault underlyingVault, PositionVault dollarVault) = FACTORY.markets(marketId);
        if (address(underlyingVault) == address(0)) {
            revert NotRegistered(marketId);
        }
        (PoolId yesPool, PoolId noPool, PoolId probabilityPool) =
            _poolsOf(underlyingVault, dollarVault);
        uint64 wasAt = freezesAt[yesPool];
        if (wasAt == 0) {
            revert NotRegistered(marketId);
        }
        // The three pools share one instant, written together, so one comparison decides for all.
        // forge-lint: disable-next-line(block-timestamp)
        if (wasAt <= block.timestamp) {
            return;
        }
        uint64 instant = SafeCast.toUint64(block.timestamp);
        freezesAt[yesPool] = instant;
        freezesAt[noPool] = instant;
        freezesAt[probabilityPool] = instant;
        emit FrozenEarly(marketId, instant, wasAt);
    }

    /// @notice Admits only a registered market's pools, before their freeze. The pool id covers the
    ///         currencies, fee, spacing and hook, so no other key with this hook can ever exist.
    /// @param key The pool being opened.
    /// @return The callback's selector.
    function beforeInitialize(address, PoolKey calldata key, uint160)
        external
        view
        returns (bytes4)
    {
        _onlyPoolManager();
        PoolId id = key.toId();
        uint64 instant = freezesAt[id];
        if (instant == 0) {
            revert NotARegisteredPool(id);
        }
        _openAt(id, instant);
        return IHooks.beforeInitialize.selector;
    }

    /// @notice Refuses every swap from the pool's freeze on, and changes nothing about one before.
    /// @param key The pool.
    /// @return The callback's selector.
    /// @return No delta.
    /// @return No fee override.
    function beforeSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata,
        bytes calldata
    ) external view returns (bytes4, BeforeSwapDelta, uint24) {
        _onlyPoolManager();
        PoolId id = key.toId();
        _openAt(id, freezesAt[id]);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @notice Refuses any caller but the pool manager.
    function _onlyPoolManager() private view {
        if (msg.sender != address(POOL_MANAGER)) {
            revert NotPoolManager(msg.sender);
        }
    }

    /// @notice Refuses a pool whose freeze has come. Several blocks share a second on this chain, so
    ///         every block stamped at the instant is already frozen.
    /// @param id The pool.
    /// @param instant Its freeze.
    function _openAt(PoolId id, uint64 instant) private view {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= instant) {
            revert Frozen(id, instant);
        }
    }

    /// @notice A market's three pools with this hook.
    /// @param underlyingVault The vault over its underlying.
    /// @param dollarVault The vault over its dollar.
    /// @return yesPool The pool of the yes legs.
    /// @return noPool The pool of the no legs.
    /// @return probabilityPool The pool of the dollar's two legs.
    function _poolsOf(PositionVault underlyingVault, PositionVault dollarVault)
        private
        view
        returns (PoolId yesPool, PoolId noPool, PoolId probabilityPool)
    {
        (PoolKey memory yes, PoolKey memory no) =
            ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(address(this)));
        return (
            yes.toId(),
            no.toId(),
            ConditionalPools.probabilityKeyOf(dollarVault, IHooks(address(this))).toId()
        );
    }
}
