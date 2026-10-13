// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {FreezeHook} from "../../src/FreezeHook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {IPermit2Calls, IPositionManagerCalls, IQuoterCalls} from "./ConditionalPoolsFork.t.sol";

/// @title FreezeHookForkTest
/// @notice A market over the real underlying and dollar, its event sealed and its three pools
///         carrying the freeze hook, on the venue as deployed at a pinned block. The pools open, are
///         seeded through the real position manager and trade; at the sealed instant every swap and
///         every quote stops, still stopped a week later, prices untouched; and the provider takes
///         every position out whole. A second market is frozen early by the guardian.
contract FreezeHookForkTest is Test {
    using PoolIdLibrary for PoolKey;

    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    /// @notice The hook's address: exactly the before-initialise and before-swap permissions.
    address internal constant HOOK =
        address(uint160(0x4444 << 144) | Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    /// @notice The position manager's action codes.
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant BURN_POSITION = 0x03;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    uint8 internal constant TAKE_PAIR = 0x11;

    /// @notice The deployed quoter's wrapper around any revert it cannot decode.
    bytes4 internal constant UNEXPECTED_REVERT_BYTES =
        bytes4(keccak256("UnexpectedRevertBytes(bytes)"));

    /// @notice Liquidity per pool, and the range's half-width (a factor of 1.2 each way).
    uint128 internal constant CONDITIONAL_LIQUIDITY = 1e16;
    uint128 internal constant PROBABILITY_LIQUIDITY = 1e11;
    int24 internal constant HALF_WIDTH = 1823;

    address internal sealer = makeAddr("sealer");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");
    address internal provider = makeAddr("provider");
    address internal trader = makeAddr("trader");

    IPoolManager internal manager;
    IPositionManagerCalls internal positions;
    IQuoterCalls internal quoter;
    IPermit2Calls internal permit2;
    PoolSwapTest internal swapRouter;
    MarketFactory internal factory;
    ThresholdRegistry internal registry;
    FreezeHook internal hook;
    IERC20 internal underlying;
    IERC20 internal dollar;

    uint64 internal announcesAt;
    bytes32 internal marketId;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;
    PoolKey[3] internal keys;
    uint256[3] internal tokenIds;
    address[4] internal legs;
    uint256[4] internal deposited;
    int256[4] internal tradedIn;

    /// @notice Opens on a fork at the pinned block, proves the venue is there, and builds a sealed,
    ///         registered market over the real underlying and dollar with the hook at its address.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);
        manager = IPoolManager(AddressBook.thirdParty("poolManager", 0));
        positions = IPositionManagerCalls(AddressBook.thirdParty("positionManager", 0));
        quoter = IQuoterCalls(AddressBook.thirdParty("v4Quoter", 0));
        permit2 = IPermit2Calls(AddressBook.thirdParty("permit2", 0));
        underlying = IERC20(AddressBook.thirdParty("collateral", 0));
        dollar = IERC20(AddressBook.thirdParty("dollar", 0));
        assertEq(block.number, pinned, "not at the pinned block");
        assertGt(
            address(manager).code.length * address(positions).code.length
                * address(quoter).code.length,
            0,
            "no code at a recorded venue contract at the pinned block: if the endpoint no longer "
            "serves this block, re-pin it; the assertion itself is not what failed"
        );

        factory = new MarketFactory();
        registry = new ThresholdRegistry();
        OptimisticResolver resolver = new OptimisticResolver(
            factory, registry, sealer, makeAddr("arbiter"), dollar, 1, 1, 1, 1, 1
        );
        deployCodeTo("FreezeHook.sol:FreezeHook", abi.encode(manager, resolver, guardian), HOOK);
        hook = FreezeHook(HOOK);
        swapRouter = new PoolSwapTest(manager);

        announcesAt = uint64(vm.getBlockTimestamp()) + 1 days;
        (marketId, underlyingVault, dollarVault) = _market(announcesAt, "earnings");
        (keys[0], keys[1]) = ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(HOOK));
        keys[2] = ConditionalPools.probabilityKeyOf(dollarVault, IHooks(HOOK));
        legs = [
            address(underlyingVault.YES()),
            address(underlyingVault.NO()),
            address(dollarVault.YES()),
            address(dollarVault.NO())
        ];
    }

    /// @notice The three pools open (one at a hostile price, restored for free), are seeded and
    ///         trade; from the sealed instant every swap and quote is refused, still a week later, with
    ///         prices untouched; and the provider takes every position out whole, the traders' inputs
    ///         included.
    function testFork_swapsStopForGoodAndLiquidityLeavesWhole() public {
        _openAll();
        _seedAll();

        // A trade in each pool, one second before the instant: still open.
        vm.warp(announcesAt - 1);
        _split(trader, 1e15, 1e6);
        int256[4] memory before;
        for (uint256 leg = 0; leg < 4; leg++) {
            before[leg] = SafeCast.toInt256(IERC20(legs[leg]).balanceOf(trader));
        }
        _sell(keys[0], legs[0], 1e15);
        _sell(keys[1], legs[1], 1e15);
        _sell(keys[2], legs[2], 1e6);
        for (uint256 leg = 0; leg < 4; leg++) {
            tradedIn[leg] = before[leg] - SafeCast.toInt256(IERC20(legs[leg]).balanceOf(trader));
        }
        // The underlying's legs were only sold, each in its own pool: exactly what was sold went in.
        assertEq(tradedIn[0], 1e15);
        assertEq(tradedIn[1], 1e15);

        // From the instant, every swap and every quote is refused, and a week later still.
        uint160[3] memory prices;
        vm.warp(announcesAt);
        for (uint256 index = 0; index < 3; index++) {
            (prices[index],,,) = StateLibrary.getSlot0(manager, keys[index].toId());
            _assertFrozen(keys[index], announcesAt);
        }
        vm.warp(announcesAt + 7 days);
        for (uint256 index = 0; index < 3; index++) {
            _assertFrozen(keys[index], announcesAt);
            (uint160 price,,,) = StateLibrary.getSlot0(manager, keys[index].toId());
            assertEq(price, prices[index], "a frozen pool's price moved");
        }

        _withdrawAllAndAccount();
    }

    /// @notice The guardian brings a second market's freeze forward: its swaps stop at once, hours
    ///         before its sealed instant, through the real pool manager.
    function testFork_theGuardianFreezesAMarketEarly() public {
        _openAll();
        _split(trader, 1e15, 0);
        vm.warp(announcesAt - 3 hours);
        _sell(keys[0], address(underlyingVault.YES()), 1);
        uint64 now_ = uint64(vm.getBlockTimestamp());
        vm.prank(guardian);
        hook.freezeNow(marketId);
        for (uint256 index = 0; index < 3; index++) {
            _assertFrozen(keys[index], now_);
        }
    }

    /// @notice Opens the three pools as a stranger: the yes pool at a hostile price of one raw unit
    ///         per raw unit, restored to its value for free by a swap against no liquidity; the
    ///         others at their values.
    function _openAll() internal {
        uint160[3] memory values = [
            ConditionalPools.sqrtPriceX96(
                keys[0], IERC20Metadata(address(underlyingVault.YES())), 1040, 0
            ),
            ConditionalPools.sqrtPriceX96(
                keys[1], IERC20Metadata(address(underlyingVault.NO())), 960, 0
            ),
            ConditionalPools.sqrtPriceAtYesDollarPrice(dollarVault, 0.6e18)
        ];
        vm.startPrank(stranger);
        manager.initialize(keys[0], uint160(1 << 96));
        manager.initialize(keys[1], values[1]);
        manager.initialize(keys[2], values[2]);
        (uint160 hostile,,,) = StateLibrary.getSlot0(manager, keys[0].toId());
        swapRouter.swap(
            keys[0],
            IPoolManager.SwapParams({
                zeroForOne: hostile > values[0], amountSpecified: -1, sqrtPriceLimitX96: values[0]
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        for (uint256 index = 0; index < 3; index++) {
            (uint160 price,,,) = StateLibrary.getSlot0(manager, keys[index].toId());
            assertEq(price, values[index], "a pool did not open at its value");
        }
    }

    /// @notice Seeds each pool with a position a fifth either side of its value, through the real
    ///         position manager, paid through Permit2.
    function _seedAll() internal {
        _split(provider, 100e18, 200_000e6);
        vm.startPrank(provider);
        for (uint256 index = 0; index < 4; index++) {
            IERC20(legs[index]).approve(address(permit2), type(uint256).max);
            permit2.approve(legs[index], address(positions), type(uint160).max, type(uint48).max);
        }
        vm.stopPrank();
        for (uint256 index = 0; index < 3; index++) {
            tokenIds[index] = positions.nextTokenId();
            _mint(keys[index], index == 2 ? PROBABILITY_LIQUIDITY : CONDITIONAL_LIQUIDITY);
        }
        // The legs are new: the manager held none of them, so what it holds now is the deposits.
        for (uint256 leg = 0; leg < 4; leg++) {
            deposited[leg] = IERC20(legs[leg]).balanceOf(address(manager));
            assertGt(deposited[leg], 0);
        }
    }

    /// @notice Mints one position around a pool's current price.
    /// @param key The pool.
    /// @param liquidity Its liquidity.
    function _mint(PoolKey memory key, uint128 liquidity) internal {
        (uint160 price, int24 tick,,) = StateLibrary.getSlot0(manager, key.toId());
        int24 lower = _floor(tick - HALF_WIDTH);
        int24 upper = _floor(tick + HALF_WIDTH) + ConditionalPools.TICK_SPACING;
        uint256 cap0 = SqrtPriceMath.getAmount0Delta(
            price, TickMath.getSqrtPriceAtTick(upper), liquidity, true
        );
        uint256 cap1 = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(lower), price, liquidity, true
        );
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            lower,
            upper,
            uint256(liquidity),
            SafeCast.toUint128(cap0),
            SafeCast.toUint128(cap1),
            provider,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        vm.prank(provider);
        positions.modifyLiquidities(
            abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), params), vm.getBlockTimestamp()
        );
    }

    /// @notice Burns every position and takes everything to the provider, then accounts per leg: no
    ///         liquidity is left; the provider gains exactly what it deposited, plus what traders put
    ///         in net, less only the rounding v4 keeps in the manager's favour, a literal measured
    ///         here; and the hook holds nothing. The terms are measured on three different holders.
    function _withdrawAllAndAccount() internal {
        uint256[4] memory before;
        for (uint256 leg = 0; leg < 4; leg++) {
            before[leg] = IERC20(legs[leg]).balanceOf(provider);
        }
        for (uint256 index = 0; index < 3; index++) {
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(tokenIds[index], uint128(0), uint128(0), bytes(""));
            params[1] = abi.encode(keys[index].currency0, keys[index].currency1, provider);
            vm.prank(provider);
            positions.modifyLiquidities(
                abi.encode(abi.encodePacked(BURN_POSITION, TAKE_PAIR), params),
                vm.getBlockTimestamp()
            );
            assertEq(
                positions.getPositionLiquidity(tokenIds[index]), 0, "a position kept liquidity"
            );
            assertEq(
                StateLibrary.getLiquidity(manager, keys[index].toId()), 0, "a pool kept liquidity"
            );
        }
        for (uint256 leg = 0; leg < 4; leg++) {
            uint256 gained = IERC20(legs[leg]).balanceOf(provider) - before[leg];
            uint256 left = IERC20(legs[leg]).balanceOf(address(manager));
            assertEq(
                SafeCast.toInt256(gained),
                SafeCast.toInt256(deposited[leg]) + tradedIn[leg] - SafeCast.toInt256(left),
                "the provider did not get back its deposit and the traders' net input"
            );
            // Measured at the pinned block, and within the bound: one raw unit per position or swap
            // that touched the leg (two, two, four and four).
            assertEq(left, [uint256(2), 2, 3, 2][leg], "the manager kept other than its rounding");
            assertEq(IERC20(legs[leg]).balanceOf(HOOK), 0, "the hook holds funds");
        }
    }

    /// @notice Asserts a pool refuses a swap through the manager and a quote through the deployed
    ///         quoter, each with the hook's own error inside the wrapper that caller adds.
    /// @param key The pool.
    /// @param instant Its freeze.
    function _assertFrozen(PoolKey memory key, uint64 instant) internal {
        bytes memory wrapped = abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            HOOK,
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(FreezeHook.Frozen.selector, key.toId(), instant),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
        vm.expectRevert(wrapped);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: true,
                amountSpecified: -1,
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.expectRevert(abi.encodeWithSelector(UNEXPECTED_REVERT_BYTES, wrapped));
        quoter.quoteExactInputSingle(
            IQuoterCalls.QuoteExactSingleParams(key, true, uint128(1e6), "")
        );
    }

    /// @notice The trader sells an exact amount of one currency in a pool.
    /// @param key The pool.
    /// @param token What is sold.
    /// @param amount How much.
    function _sell(PoolKey memory key, address token, uint256 amount) internal {
        bool zeroForOne = Currency.unwrap(key.currency0) == token;
        vm.startPrank(trader);
        IERC20(token).approve(address(swapRouter), amount);
        swapRouter.swap(
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
    }

    /// @notice A sealed event and a market on it with the canonical resolver, registered.
    /// @param at When the figure may first be public.
    /// @param terms The event's terms.
    /// @return id The market.
    /// @return underlyingVault_ Its vault over the underlying.
    /// @return dollarVault_ Its vault over the dollar.
    function _market(uint64 at, bytes memory terms)
        internal
        returns (bytes32 id, PositionVault underlyingVault_, PositionVault dollarVault_)
    {
        vm.prank(sealer);
        bytes32 eventId = registry.seal(
            ThresholdRegistry.Threshold({
                value: 1, decimals: 0, announcesAt: at, deadline: at + 1 days, terms: terms
            })
        );
        id = factory.createMarket(
            underlying,
            dollar,
            eventId,
            address(hook.RESOLVER()),
            type(uint256).max,
            type(uint256).max
        );
        vm.prank(stranger);
        assertEq(hook.register(id, eventId), id);
        (underlyingVault_, dollarVault_) = factory.markets(id);
    }

    /// @notice Gives `holder` legs of both vaults by splitting fabricated collateral.
    /// @dev The collateral balances are fabricated with the storage cheatcode.
    /// @param holder Who receives the legs.
    /// @param shares How much of the underlying to split.
    /// @param dollars How much of the dollar to split.
    function _split(address holder, uint256 shares, uint256 dollars) internal {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        uint256[2] memory splits = [shares, dollars];
        for (uint256 index = 0; index < 2; index++) {
            if (splits[index] == 0) {
                continue;
            }
            IERC20 collateral = vaults[index].COLLATERAL();
            deal(address(collateral), holder, splits[index]);
            vm.startPrank(holder);
            collateral.approve(address(vaults[index]), splits[index]);
            vaults[index].splitPosition(splits[index]);
            vm.stopPrank();
        }
    }

    /// @notice A tick rounded down to the spacing.
    /// @param tick The tick.
    /// @return The rounded tick.
    function _floor(int24 tick) internal pure returns (int24) {
        int24 spacing = ConditionalPools.TICK_SPACING;
        return tick / spacing * spacing - (tick % spacing < 0 ? spacing : int24(0));
    }
}
