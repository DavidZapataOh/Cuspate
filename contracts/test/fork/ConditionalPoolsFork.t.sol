// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {PositionVault} from "../../src/PositionVault.sol";

/// @notice The part of the deployed position manager this test calls.
interface IPositionManagerCalls {
    /// @notice Runs a batch of actions inside one unlock of the pool manager.
    /// @param unlockData The actions and their parameters.
    /// @param deadline The latest timestamp the batch may run at.
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;

    /// @notice The id the next minted position receives.
    /// @return The id.
    function nextTokenId() external view returns (uint256);

    /// @notice A position's liquidity.
    /// @param tokenId The position.
    /// @return liquidity Its liquidity.
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);
}

/// @notice The part of the deployed quoter this test calls.
interface IQuoterCalls {
    /// @notice A single-pool quote.
    /// @param poolKey The pool.
    /// @param zeroForOne Whether the first currency is sold.
    /// @param exactAmount How much is sold.
    /// @param hookData Data for the pool's hook.
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    /// @notice What selling an exact amount in one pool would return.
    /// @param params The quote.
    /// @return amountOut The amount received.
    /// @return gasEstimate The gas the swap would use.
    function quoteExactInputSingle(QuoteExactSingleParams memory params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

/// @notice The part of the deployed state view this test calls.
interface IStateViewCalls {
    /// @notice A pool's price, tick and fees.
    /// @param poolId The pool.
    /// @return sqrtPriceX96 The square root of its price.
    /// @return tick Its tick.
    /// @return protocolFee The protocol's fee.
    /// @return lpFee The liquidity providers' fee.
    function getSlot0(PoolId poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

/// @notice The part of the deployed Permit2 this test calls.
interface IPermit2Calls {
    /// @notice Lets `spender` move up to `amount` of `token` until `expiration`.
    /// @param token The token.
    /// @param spender Who may move it.
    /// @param amount How much.
    /// @param expiration Until when.
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title ConditionalPoolsForkTest
/// @notice Both pools of a market over the real underlying and dollar, opened by a stranger on the
///         venue as deployed at a pinned block, seeded through the real position manager, and read
///         back from chain state and from the real quoter. Every expected price is a literal
///         computed off chain; the code under test only supplies the price the pools are opened at.
contract ConditionalPoolsForkTest is Test {
    using PoolIdLibrary for PoolKey;

    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    bytes32 internal constant EVENT = keccak256("an event");

    /// @notice What a share is worth in dollars if the event happens, and if it does not.
    uint256 internal constant VALUE_IF_YES = 1040;
    uint256 internal constant VALUE_IF_NO = 960;

    /// @notice The position seeded in each pool, and its half-width: 1,823 ticks is a factor of
    ///         1.2, so the range runs from a fifth below the value to a fifth above it.
    uint128 internal constant LIQUIDITY = 1e16;
    int24 internal constant HALF_WIDTH = 1823;

    /// @notice A thousandth of a share, small enough that the position's price impact is far below
    ///         one tick.
    uint128 internal constant QUOTED_SHARE = 1e15;

    /// @notice The position manager's action codes.
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant SETTLE_PAIR = 0x0d;

    address internal stranger = makeAddr("stranger");
    address internal provider = makeAddr("provider");
    address internal trader = makeAddr("trader");

    IPoolManager internal manager;
    IPositionManagerCalls internal positions;
    IQuoterCalls internal quoter;
    IStateViewCalls internal stateView;
    IPermit2Calls internal permit2;
    PoolSwapTest internal swapRouter;

    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;
    PoolKey internal yesKey;
    PoolKey internal noKey;

    /// @notice What a pool must read back: its price and tick, and the quotes for a thousandth of
    ///         a share each way, all computed off chain.
    /// @param key The pool.
    /// @param share The leg of the underlying in it.
    /// @param dollar The leg of the dollar in it.
    /// @param value The share's value in that world, in whole dollars.
    /// @param sqrtPriceX96 The square root of the price it opens at.
    /// @param tick The tick it opens at.
    /// @param dollarsForShare The dollars a thousandth of a share sells for, after the fee.
    /// @param sharesForDollars The share bought with a thousandth of a share's worth of dollars.
    struct Expected {
        PoolKey key;
        address share;
        address dollar;
        uint256 value;
        uint160 sqrtPriceX96;
        int24 tick;
        uint256 dollarsForShare;
        uint256 sharesForDollars;
    }

    /// @notice Opens on a fork at the pinned block, proves the venue is there, and creates a
    ///         market over the real underlying and dollar.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);

        manager = IPoolManager(AddressBook.thirdParty("poolManager", 0));
        positions = IPositionManagerCalls(AddressBook.thirdParty("positionManager", 0));
        quoter = IQuoterCalls(AddressBook.thirdParty("v4Quoter", 0));
        stateView = IStateViewCalls(AddressBook.thirdParty("stateView", 0));
        permit2 = IPermit2Calls(AddressBook.thirdParty("permit2", 0));
        assertEq(block.chainid, PRODUCTION_CHAIN, "not on a fork of the production chain");
        assertEq(block.number, pinned, "not at the pinned block");
        assertGt(
            address(manager).code.length * address(positions).code.length
                * address(quoter).code.length * address(stateView).code.length
                * address(permit2).code.length,
            0,
            "no code at a recorded venue contract at the pinned block: if the endpoint no longer "
            "serves this block, re-pin it; the assertion itself is not what failed"
        );

        MarketFactory factory = new MarketFactory();
        (underlyingVault, dollarVault) = factory.markets(
            factory.createMarket(
                IERC20(AddressBook.thirdParty("collateral", 0)),
                IERC20(AddressBook.thirdParty("dollar", 0)),
                EVENT,
                makeAddr("resolver")
            )
        );
        (yesKey, noKey) = ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(address(0)));
        swapRouter = new PoolSwapTest(manager);
    }

    /// @notice A stranger opens both pools at their conditional values; once seeded, each reads
    ///         back exactly that price from chain state, and the real quoter prices a thousandth of
    ///         a share at the value, less the fee, in both directions.
    function testFork_bothPoolsQuoteTheirConditionalValues() public {
        _openAndCheck(_expectedYes());
        _openAndCheck(_expectedNo());
    }

    /// @notice A stranger opens the pool at its value, no one can open it again, and once seeded it
    ///         reads back that price and those quotes.
    /// @param pool The expectation.
    function _openAndCheck(Expected memory pool) internal {
        uint160 opening =
            ConditionalPools.sqrtPriceX96(pool.key, IERC20Metadata(pool.share), pool.value, 0);
        assertEq(opening, pool.sqrtPriceX96, "the opening price is not the value");
        vm.prank(stranger);
        assertEq(
            manager.initialize(pool.key, opening), pool.tick, "the pool opened at another tick"
        );
        vm.expectRevert(Pool.PoolAlreadyInitialized.selector);
        manager.initialize(pool.key, opening);

        _seed(pool.key, pool.tick);
        _assertSlot0(pool);
        _assertQuotes(pool);
    }

    /// @notice A real exact-input swap pays exactly what the deployed quoter quoted: the quote and
    ///         the swap are two code paths, and they agree.
    function testFork_aSwapPaysWhatTheQuoterQuoted() public {
        Expected memory pool = _expectedYes();
        vm.prank(stranger);
        manager.initialize(pool.key, pool.sqrtPriceX96);
        _seed(pool.key, pool.tick);

        bool shareFirst = Currency.unwrap(pool.key.currency0) == pool.share;
        (uint256 quoted,) = quoter.quoteExactInputSingle(
            IQuoterCalls.QuoteExactSingleParams(pool.key, shareFirst, QUOTED_SHARE, "")
        );
        _split(trader, QUOTED_SHARE, 0);
        vm.startPrank(trader);
        IERC20(pool.share).approve(address(swapRouter), QUOTED_SHARE);
        swapRouter.swap(
            pool.key,
            IPoolManager.SwapParams({
                zeroForOne: shareFirst,
                amountSpecified: -int256(uint256(QUOTED_SHARE)),
                sqrtPriceLimitX96: shareFirst
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        assertEq(IERC20(pool.share).balanceOf(trader), 0, "the share was not sold in full");
        assertEq(
            IERC20(pool.dollar).balanceOf(trader), quoted, "the swap paid other than the quote"
        );
    }

    /// @notice A pool someone else opened at a hostile price is restored, for free, by a swap
    ///         against no liquidity before the position is minted; minting first would have been
    ///         refused by the position's amount caps rather than filled at the hostile price.
    function testFork_aHostileOpeningIsUndoneBeforeSeeding() public {
        Expected memory pool = _expectedYes();
        vm.prank(stranger);
        manager.initialize(pool.key, uint160(1 << 96));

        _fund(pool.key, pool.tick);
        bytes memory unlockData = _mintData(pool.key, pool.tick);
        bytes memory refusal = _refusalAtAPriceOfOne(pool);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(provider);
        vm.expectRevert(refusal, address(positions));
        positions.modifyLiquidities(unlockData, deadline);

        uint256 sharesBefore = IERC20(pool.share).balanceOf(provider);
        uint256 dollarsBefore = IERC20(pool.dollar).balanceOf(provider);
        _restore(pool);
        assertEq(
            IERC20(pool.share).balanceOf(provider), sharesBefore, "restoring the price cost shares"
        );
        assertEq(
            IERC20(pool.dollar).balanceOf(provider),
            dollarsBefore,
            "restoring the price cost dollars"
        );
        _assertSlot0(pool);
        _mint(pool.key, pool.tick);
        _assertQuotes(pool);
    }

    /// @notice The refusal a mint meets in a pool opened at a price of one, raw for raw: the whole
    ///         range lies on one side of that price, so the position would take a single currency,
    ///         far beyond what the value's price caps it at.
    /// @param pool The expectation.
    /// @return The refusal, with the cap and the amount the position would have taken.
    function _refusalAtAPriceOfOne(Expected memory pool) internal view returns (bytes memory) {
        (int24 lower, int24 upper) = _range(pool.tick);
        (uint128 cap0, uint128 cap1) = _caps(pool.key, pool.tick);
        (uint160 sqrtLower, uint160 sqrtUpper) =
            (TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper));
        return upper <= 0
            ? abi.encodeWithSignature(
                "MaximumAmountExceeded(uint128,uint128)",
                cap1,
                SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, LIQUIDITY, true)
            )
            : abi.encodeWithSignature(
                "MaximumAmountExceeded(uint128,uint128)",
                cap0,
                SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, LIQUIDITY, true)
            );
    }

    /// @notice Moves an empty pool to the value's price with a swap against no liquidity, which
    ///         crosses no position and so costs nothing.
    /// @param pool The expectation.
    function _restore(Expected memory pool) internal {
        (uint160 current,,,) = stateView.getSlot0(pool.key.toId());
        vm.prank(provider);
        swapRouter.swap(
            pool.key,
            IPoolManager.SwapParams({
                zeroForOne: current > pool.sqrtPriceX96,
                amountSpecified: -1,
                sqrtPriceLimitX96: pool.sqrtPriceX96
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @notice The yes pool: a share at 1,040 dollars.
    /// @return pool What it must read back.
    function _expectedYes() internal view returns (Expected memory pool) {
        pool = _expected(
            yesKey, address(underlyingVault.YES()), address(dollarVault.YES()), VALUE_IF_YES
        );
        bool shareFirst = Currency.unwrap(yesKey.currency0) == pool.share;
        (pool.sqrtPriceX96, pool.tick) = shareFirst
            ? (uint160(2555031468456337426639666), int24(-206851))
            : (uint160(2456761027361862910230448246114972), int24(206850));
        (pool.dollarsForShare, pool.sharesForDollars) = (1036880, 997e12);
    }

    /// @notice The no pool: a share at 960 dollars.
    /// @return pool What it must read back.
    function _expectedNo() internal view returns (Expected memory pool) {
        pool =
            _expected(noKey, address(underlyingVault.NO()), address(dollarVault.NO()), VALUE_IF_NO);
        bool shareFirst = Currency.unwrap(noKey.currency0) == pool.share;
        (pool.sqrtPriceX96, pool.tick) = shareFirst
            ? (uint160(2454794831746884205029622), int24(-207652))
            : (uint160(2557077949736337713572523183064707), int24(207651));
        (pool.dollarsForShare, pool.sharesForDollars) = (957120, 997e12);
    }

    /// @notice The parts of an expectation that come from the market itself.
    /// @param key The pool.
    /// @param share The leg of the underlying.
    /// @param dollar The leg of the dollar.
    /// @param value The share's value.
    /// @return pool The expectation, its prices still to be filled.
    function _expected(PoolKey memory key, address share, address dollar, uint256 value)
        internal
        pure
        returns (Expected memory pool)
    {
        pool.key = key;
        pool.share = share;
        pool.dollar = dollar;
        pool.value = value;
    }

    /// @notice The pool reads back exactly the expected price and tick, with the fee it was keyed
    ///         at and no protocol fee.
    /// @param pool The expectation.
    function _assertSlot0(Expected memory pool) internal view {
        (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) =
            stateView.getSlot0(pool.key.toId());
        assertEq(sqrtPriceX96, pool.sqrtPriceX96, "the pool's price is not the value");
        assertEq(tick, pool.tick, "the pool's tick is not the value's");
        assertEq(protocolFee, 0, "a protocol fee is taken");
        assertEq(lpFee, 3000, "the pool's fee is not the keyed fee");
    }

    /// @notice The real quoter prices a thousandth of a share, sold for dollars and bought with
    ///         dollars, at the expected amounts, within one tick and one raw unit.
    /// @param pool The expectation.
    function _assertQuotes(Expected memory pool) internal {
        bool shareFirst = Currency.unwrap(pool.key.currency0) == pool.share;
        (uint256 dollarsOut,) = quoter.quoteExactInputSingle(
            IQuoterCalls.QuoteExactSingleParams(pool.key, shareFirst, QUOTED_SHARE, "")
        );
        assertApproxEqAbs(
            dollarsOut, pool.dollarsForShare, pool.dollarsForShare / 1e4 + 1, "selling a share"
        );
        // A thousandth of a share's worth of dollars: the value, in six-decimal raw units, divided
        // by a thousand.
        (uint256 sharesOut,) = quoter.quoteExactInputSingle(
            IQuoterCalls.QuoteExactSingleParams(
                pool.key, !shareFirst, uint128(pool.value * 1e3), ""
            )
        );
        assertApproxEqAbs(
            sharesOut, pool.sharesForDollars, pool.sharesForDollars / 1e4 + 1, "buying a share"
        );
    }

    /// @notice Funds the provider and mints the position around the value.
    /// @param key The pool.
    /// @param tick The value's tick.
    function _seed(PoolKey memory key, int24 tick) internal {
        _fund(key, tick);
        _mint(key, tick);
    }

    /// @notice Splits enough collateral for the provider to cover the position's caps, and lets
    ///         the position manager draw it through Permit2.
    /// @param key The pool.
    /// @param tick The value's tick.
    function _fund(PoolKey memory key, int24 tick) internal {
        (uint128 cap0, uint128 cap1) = _caps(key, tick);
        bool underlyingFirst = _isUnderlyingLeg(Currency.unwrap(key.currency0));
        (uint256 shares, uint256 dollars) = underlyingFirst ? (cap0, cap1) : (cap1, cap0);
        _split(provider, shares, dollars);
        address[2] memory currencies =
            [Currency.unwrap(key.currency0), Currency.unwrap(key.currency1)];
        vm.startPrank(provider);
        for (uint256 index = 0; index < 2; index++) {
            IERC20(currencies[index]).approve(address(permit2), type(uint256).max);
            permit2.approve(
                currencies[index], address(positions), type(uint160).max, type(uint48).max
            );
        }
        vm.stopPrank();
    }

    /// @notice Mints the position through the real position manager, the amounts it may take
    ///         capped at what the value's price requires.
    /// @param key The pool.
    /// @param tick The value's tick.
    function _mint(PoolKey memory key, int24 tick) internal {
        bytes memory unlockData = _mintData(key, tick);
        uint256 tokenId = positions.nextTokenId();
        vm.prank(provider);
        positions.modifyLiquidities(unlockData, vm.getBlockTimestamp());
        assertEq(
            positions.getPositionLiquidity(tokenId), LIQUIDITY, "the position holds other liquidity"
        );
    }

    /// @notice The batch that mints the position and pays for it.
    /// @param key The pool.
    /// @param tick The value's tick.
    /// @return The batch.
    function _mintData(PoolKey memory key, int24 tick) internal view returns (bytes memory) {
        (int24 lower, int24 upper) = _range(tick);
        (uint128 cap0, uint128 cap1) = _caps(key, tick);
        bytes[] memory params = new bytes[](2);
        params[0] =
            abi.encode(key, lower, upper, uint256(LIQUIDITY), cap0, cap1, provider, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        return abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), params);
    }

    /// @notice What the position needs of each currency at the value's price, rounded up.
    /// @param key The pool.
    /// @param tick The value's tick.
    /// @return cap0 The first currency.
    /// @return cap1 The second.
    function _caps(PoolKey memory key, int24 tick)
        internal
        view
        returns (uint128 cap0, uint128 cap1)
    {
        (int24 lower, int24 upper) = _range(tick);
        Expected memory pool = PoolId.unwrap(key.toId()) == PoolId.unwrap(yesKey.toId())
            ? _expectedYes()
            : _expectedNo();
        uint160 price = pool.sqrtPriceX96;
        cap0 = uint128(
            SqrtPriceMath.getAmount0Delta(
                price, TickMath.getSqrtPriceAtTick(upper), LIQUIDITY, true
            )
        );
        cap1 = uint128(
            SqrtPriceMath.getAmount1Delta(
                TickMath.getSqrtPriceAtTick(lower), price, LIQUIDITY, true
            )
        );
    }

    /// @notice The position's range: a fifth either side of the value, widened to the spacing.
    /// @param tick The value's tick.
    /// @return lower The lower tick.
    /// @return upper The upper tick.
    function _range(int24 tick) internal pure returns (int24 lower, int24 upper) {
        int24 spacing = ConditionalPools.TICK_SPACING;
        lower = tick - HALF_WIDTH;
        lower = lower / spacing * spacing - (lower % spacing < 0 ? spacing : int24(0));
        upper = tick + HALF_WIDTH;
        upper = upper / spacing * spacing + (upper % spacing > 0 ? spacing : int24(0));
    }

    /// @notice Gives `holder` legs of both vaults by splitting fabricated collateral.
    /// @dev The collateral balances are fabricated with the storage cheatcode.
    /// @param holder Who receives the legs.
    /// @param shares How much of the underlying to split.
    /// @param dollars How much of the dollar to split.
    function _split(address holder, uint256 shares, uint256 dollars) internal {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        uint256[2] memory amounts = [shares, dollars];
        for (uint256 index = 0; index < 2; index++) {
            if (amounts[index] == 0) {
                continue;
            }
            IERC20 collateral = vaults[index].COLLATERAL();
            deal(address(collateral), holder, amounts[index]);
            vm.startPrank(holder);
            collateral.approve(address(vaults[index]), amounts[index]);
            vaults[index].splitPosition(amounts[index]);
            vm.stopPrank();
        }
    }

    /// @notice Whether a currency is a leg of the underlying.
    /// @param currency The currency.
    /// @return Whether it is.
    function _isUnderlyingLeg(address currency) internal view returns (bool) {
        return
            currency == address(underlyingVault.YES()) || currency == address(underlyingVault.NO());
    }
}
