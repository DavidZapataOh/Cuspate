// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Vm} from "forge-std/Vm.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {PositionRouter} from "../../src/PositionRouter.sol";
import {FreezeHook} from "../../src/FreezeHook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {IQuoterCalls} from "./ConditionalPoolsFork.t.sol";

/// @notice The least a smart account does: its owner signs one transaction that runs a batch of calls
///         from the account, all or nothing. It stands in for the embedded wallet's account, whose
///         real type is proven elsewhere.
contract BatchAccount {
    /// @notice One call of a batch.
    /// @param target The contract called.
    /// @param data The calldata.
    struct Call {
        address target;
        bytes data;
    }

    /// @notice Who may run a batch.
    address public immutable OWNER;

    /// @notice Records the owner.
    /// @param owner The owner.
    constructor(address owner) {
        OWNER = owner;
    }

    /// @notice Runs every call in order from this account, reverting with the first failure's data.
    /// @param calls The batch.
    function execute(Call[] calldata calls) external {
        require(msg.sender == OWNER, "not the owner");
        for (uint256 index = 0; index < calls.length; index++) {
            (bool success, bytes memory result) = calls[index].target.call(calls[index].data);
            if (!success) {
                assembly ("memory-safe") {
                    revert(add(result, 32), mload(result))
                }
            }
        }
    }
}

/// @title PositionRouterForkTest
/// @notice On the venue as deployed at a pinned block, with the real dollar: an account holding only
///         dollars enters a conditional position with one transaction its owner signs once — the
///         dollar's approval and the entry in one batch — and receives exactly what the deployed
///         quoter quotes, plus every dollar it paid as the other world's dollar leg.
contract PositionRouterForkTest is Test {
    using PoolIdLibrary for PoolKey;

    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    /// @notice The hook's address: exactly the before-initialise and before-swap permissions.
    address internal constant HOOK =
        address(uint160(0x4444 << 144) | Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    /// @notice A hundred dollars, in the dollar's six decimals.
    uint256 internal constant DOLLARS = 100e6;

    address internal owner = makeAddr("owner");
    address internal sealer = makeAddr("sealer");

    IPoolManager internal manager;
    IQuoterCalls internal quoter;
    IERC20 internal underlying;
    IERC20 internal dollar;
    PositionRouter internal router;
    BatchAccount internal account;

    bytes32 internal marketId;
    uint64 internal announcesAt;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;
    PoolKey internal yesKey;
    PoolKey internal noKey;
    PoolKey internal probabilityKey;

    /// @notice A sealed, registered market over the real underlying and dollar, its pools open at
    ///         1,040 and 960 dollars a share and seeded, the router, and an account holding only
    ///         dollars.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);
        manager = IPoolManager(AddressBook.thirdParty("poolManager", 0));
        quoter = IQuoterCalls(AddressBook.thirdParty("v4Quoter", 0));
        underlying = IERC20(AddressBook.thirdParty("collateral", 0));
        dollar = IERC20(AddressBook.thirdParty("dollar", 0));
        assertEq(block.number, pinned, "not at the pinned block");
        assertGt(
            address(manager).code.length * address(quoter).code.length
                * address(dollar).code.length,
            0,
            "no code at a recorded contract at the pinned block: if the endpoint no longer serves "
            "this block, re-pin it; the assertion itself is not what failed"
        );

        MarketFactory factory = new MarketFactory();
        ThresholdRegistry registry = new ThresholdRegistry();
        OptimisticResolver resolver = new OptimisticResolver(
            factory, registry, sealer, makeAddr("arbiter"), dollar, 1, 1, 1, 1, 1
        );
        deployCodeTo(
            "FreezeHook.sol:FreezeHook", abi.encode(manager, resolver, makeAddr("guardian")), HOOK
        );
        announcesAt = uint64(vm.getBlockTimestamp()) + 1 days;
        vm.prank(sealer);
        bytes32 eventId = registry.seal(
            ThresholdRegistry.Threshold({
                value: 1,
                decimals: 0,
                announcesAt: announcesAt,
                deadline: announcesAt + 1 days,
                terms: "e"
            })
        );
        marketId = factory.createMarket(underlying, dollar, eventId, address(resolver));
        FreezeHook(HOOK).register(underlying, dollar, eventId);
        (underlyingVault, dollarVault) = factory.markets(marketId);
        (yesKey, noKey) = ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(HOOK));
        probabilityKey = ConditionalPools.probabilityKeyOf(dollarVault, IHooks(HOOK));
        _seed(
            yesKey,
            ConditionalPools.sqrtPriceX96(
                yesKey, IERC20Metadata(address(underlyingVault.YES())), 1040, 0
            ),
            1e16
        );
        _seed(
            noKey,
            ConditionalPools.sqrtPriceX96(
                noKey, IERC20Metadata(address(underlyingVault.NO())), 960, 0
            ),
            1e16
        );
        _seed(probabilityKey, ConditionalPools.sqrtPriceAtYesDollarPrice(dollarVault, 0.6e18), 1e11);

        router = new PositionRouter(FreezeHook(HOOK));
        account = new BatchAccount(owner);
        deal(address(dollar), address(account), DOLLARS);
    }

    /// @notice One signed transaction, from an account holding only dollars: it ends holding the yes
    ///         share the deployed quoter quoted for its yes-dollars and every no-dollar it paid, with
    ///         no dollar and no allowance left; the router holds nothing.
    function testFork_anAccountHoldingOnlyDollarsEntersInOneTransaction() public {
        assertEq(underlyingVault.YES().balanceOf(address(account)), 0);
        assertEq(dollarVault.NO().balanceOf(address(account)), 0);
        bool zeroForOne = Currency.unwrap(yesKey.currency0) == address(dollarVault.YES());
        (uint256 quoted,) = quoter.quoteExactInputSingle(
            IQuoterCalls.QuoteExactSingleParams(yesKey, zeroForOne, uint128(DOLLARS), "")
        );

        vm.prank(owner);
        account.execute(_batch(quoted));

        assertEq(
            underlyingVault.YES().balanceOf(address(account)), quoted, "the share is not the quote"
        );
        assertEq(
            dollarVault.NO().balanceOf(address(account)),
            DOLLARS,
            "the dollars kept are not those paid"
        );
        assertEq(dollar.balanceOf(address(account)), 0);
        assertEq(dollar.allowance(address(account), address(router)), 0, "an allowance was left");
        assertEq(dollar.balanceOf(address(router)), 0);
        assertEq(dollarVault.YES().balanceOf(address(router)), 0);
        assertEq(dollarVault.NO().balanceOf(address(router)), 0);
    }

    /// @notice The Done-when: a position opened and closed before the freeze settles at the quoted
    ///         prices, with every fee accounted. The account enters 100 dollars in the yes world in
    ///         one batch and exits all of it, levelled, in a second. The sale and the level each pay
    ///         exactly the deployed quoter's quote; each of the three swaps' fee, read from its pool's
    ///         price before and after rather than from any quote, is 0.3% of its input; no protocol
    ///         fee is taken; and the dollars back agree with the closed form.
    function testFork_aRoundTripSettlesAtTheQuotedPricesWithEveryFeeAccounted() public {
        (uint256 shares, uint160 yesAfterEntry) = _enterMeasuringTheFee();
        PositionRouter.Fill memory fill = _exitMeasuringTheFees(shares, yesAfterEntry);

        // Closed form: a round trip in one pool loses the fee twice and its impact cancels, so the
        // world dollars are about D * f**2; levelling the gap at a yes-dollar of p costs one more
        // fee: D - (D - D * f**2) / (1 + f * (1 - p) / p) = 99,640,108 for D = 100 dollars,
        // f = 0.997, p = 0.6. What remains is rounding and the probability pool's impact.
        assertApproxEqRel(
            fill.dollars, 99_640_108, 1e12, "the dollars back are not the closed form"
        );
        assertEq(dollar.balanceOf(address(account)), fill.dollars);
        assertEq(underlyingVault.YES().balanceOf(address(account)), 0);
        assertEq(underlyingVault.YES().allowance(address(account), address(router)), 0);
        assertEq(dollarVault.NO().allowance(address(account), address(router)), 0);
        PoolKey[3] memory keys = [yesKey, noKey, probabilityKey];
        for (uint256 index = 0; index < 3; index++) {
            (,, uint24 protocolFee,) = StateLibrary.getSlot0(manager, keys[index].toId());
            assertEq(protocolFee, 0, "a protocol fee is taken");
        }
    }

    /// @notice The entry, at the quoter's quote, its fee read from the yes pool's state.
    /// @return shares The shares bought.
    /// @return yesAfterEntry The yes pool's price after the entry.
    function _enterMeasuringTheFee() internal returns (uint256 shares, uint160 yesAfterEntry) {
        (uint160 yesBefore,,,) = StateLibrary.getSlot0(manager, yesKey.toId());
        bool dollarFirst = Currency.unwrap(yesKey.currency0) == address(dollarVault.YES());
        (shares,) = quoter.quoteExactInputSingle(
            IQuoterCalls.QuoteExactSingleParams(yesKey, dollarFirst, uint128(DOLLARS), "")
        );
        BatchAccount.Call[] memory calls = _batch(shares);
        vm.prank(owner);
        account.execute(calls);
        (yesAfterEntry,,,) = StateLibrary.getSlot0(manager, yesKey.toId());
        _assertFee(yesKey, yesBefore, yesAfterEntry, DOLLARS, shares, dollarFirst);
    }

    /// @notice The exit, levelled as the interface would level it: the sale and the level at their
    ///         quotes exactly, each fee read from its pool's state.
    /// @param shares The shares to sell.
    /// @param yesAfterEntry The yes pool's price before the sale.
    /// @return fill What the exit filled.
    function _exitMeasuringTheFees(uint256 shares, uint160 yesAfterEntry)
        internal
        returns (PositionRouter.Fill memory fill)
    {
        bool shareFirst =
            Currency.unwrap(yesKey.currency0) == address(underlyingVault.YES());
        (uint256 out,) = quoter.quoteExactInputSingle(
            IQuoterCalls.QuoteExactSingleParams(yesKey, shareFirst, uint128(shares), "")
        );
        (uint256 level, uint256 levelOut) = _searchLevel(shares, out);
        assertGt(level, 0);
        (uint160 probabilityBefore,,,) = StateLibrary.getSlot0(manager, probabilityKey.toId());
        // Built first: the batch reads the legs, and a prank is spent on the first call made.
        BatchAccount.Call[] memory calls = _exitBatch(shares, out, level, levelOut);
        vm.recordLogs();
        vm.prank(owner);
        account.execute(calls);
        fill = _exited();
        assertEq(fill.out, out, "the sale is not its quote");
        assertEq(fill.levelOut, levelOut, "the level is not its quote");
        assertLe(fill.yesLeft + fill.noLeft, 1, "the level left more than a raw unit");

        (uint160 yesAfterExit,,,) = StateLibrary.getSlot0(manager, yesKey.toId());
        _assertFee(yesKey, yesAfterEntry, yesAfterExit, shares, out, shareFirst);
        (uint160 probabilityAfter,,,) = StateLibrary.getSlot0(manager, probabilityKey.toId());
        bool noDollarFirst = Currency.unwrap(probabilityKey.currency0) == address(dollarVault.NO());
        _assertFee(
            probabilityKey, probabilityBefore, probabilityAfter, level, levelOut, noDollarFirst
        );
    }

    /// @notice From the freeze no position can be closed: the exit batch reverts whole, with the
    ///         hook's error and the yes pool's id, and the account keeps its legs.
    function testFork_theExitBatchRevertsAtTheFreeze() public {
        (uint256 shares,) = _enterMeasuringTheFee();
        vm.warp(announcesAt);
        BatchAccount.Call[] memory calls = _exitBatch(shares, 1, 0, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                HOOK,
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(FreezeHook.Frozen.selector, yesKey.toId(), announcesAt),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        vm.prank(owner);
        account.execute(calls);
        assertEq(underlyingVault.YES().balanceOf(address(account)), shares);
        assertEq(dollarVault.NO().balanceOf(address(account)), DOLLARS);
    }

    /// @notice One swap's fee, from its pool's state: with liquidity constant over the move, the
    ///         input that moved the price is the price delta's amount rounded up, the output the
    ///         other side's rounded down, and the fee is the rest of the input, 0.3% of it.
    /// @param key The pool.
    /// @param before Its price before the swap.
    /// @param after_ Its price after.
    /// @param amountIn The swap's input.
    /// @param out The swap's output.
    /// @param zeroForOne Its direction.
    function _assertFee(
        PoolKey memory key,
        uint160 before,
        uint160 after_,
        uint256 amountIn,
        uint256 out,
        bool zeroForOne
    ) internal view {
        uint128 liquidity = StateLibrary.getLiquidity(manager, key.toId());
        (uint256 moving, uint256 paid) = zeroForOne
            ? (
                SqrtPriceMath.getAmount0Delta(after_, before, liquidity, true),
                SqrtPriceMath.getAmount1Delta(after_, before, liquidity, false)
            )
            : (
                SqrtPriceMath.getAmount1Delta(before, after_, liquidity, true),
                SqrtPriceMath.getAmount0Delta(before, after_, liquidity, false)
            );
        assertEq(out, paid, "the output is not what the price move pays");
        assertApproxEqAbs(
            amountIn - moving,
            FullMath.mulDivRoundingUp(amountIn, 3000, 1e6),
            1,
            "the fee is not 0.3%"
        );
    }

    /// @notice The level, as the interface finds it: on a copy of the state with the sale done, the
    ///         largest amount of the kept no-dollars whose quoted yes-dollars still leave at least as
    ///         many no-dollars as yes-dollars; and its quote.
    /// @param shares The shares sold.
    /// @param out What they sell for.
    /// @return level The level.
    /// @return levelOut Its quote.
    function _searchLevel(uint256 shares, uint256 out)
        internal
        returns (uint256 level, uint256 levelOut)
    {
        uint256 snapshot = vm.snapshotState();
        _sellByHand(yesKey, address(underlyingVault.YES()), shares);
        bool noFirst = Currency.unwrap(probabilityKey.currency0) == address(dollarVault.NO());
        (uint256 low, uint256 high) = (0, DOLLARS - out);
        while (low < high) {
            uint256 middle = (low + high + 1) / 2;
            (uint256 quote,) = quoter.quoteExactInputSingle(
                IQuoterCalls.QuoteExactSingleParams(probabilityKey, noFirst, uint128(middle), "")
            );
            if (DOLLARS - middle >= out + quote) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        level = low;
        (levelOut,) = quoter.quoteExactInputSingle(
            IQuoterCalls.QuoteExactSingleParams(probabilityKey, noFirst, uint128(level), "")
        );
        vm.revertToState(snapshot);
    }

    /// @notice Sells by hand through v4-core's test router, from a holder given the input.
    /// @param key The pool.
    /// @param input What is sold.
    /// @param amount How much.
    function _sellByHand(PoolKey memory key, address input, uint256 amount) internal {
        PoolSwapTest swapper = new PoolSwapTest(manager);
        bool zeroForOne = Currency.unwrap(key.currency0) == input;
        deal(input, address(this), amount);
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
    }

    /// @notice The exit batch: approve the shares and the kept no-dollars, then exit with both floors
    ///         at their quotes.
    /// @param shares The shares.
    /// @param out The sale's quote.
    /// @param level The level.
    /// @param levelOut Its quote.
    /// @return calls The batch.
    function _exitBatch(uint256 shares, uint256 out, uint256 level, uint256 levelOut)
        internal
        view
        returns (BatchAccount.Call[] memory calls)
    {
        PositionRouter.ExitOrder memory order = PositionRouter.ExitOrder({
            marketId: marketId,
            yes: true,
            shares: shares,
            kept: DOLLARS,
            minOut: out,
            levelSellsWorldDollar: false,
            level: level,
            minLevelOut: levelOut,
            recipient: address(account),
            deadline: vm.getBlockTimestamp()
        });
        calls = new BatchAccount.Call[](3);
        calls[0] = BatchAccount.Call(
            address(underlyingVault.YES()),
            abi.encodeCall(IERC20.approve, (address(router), shares))
        );
        calls[1] = BatchAccount.Call(
            address(dollarVault.NO()), abi.encodeCall(IERC20.approve, (address(router), DOLLARS))
        );
        calls[2] = BatchAccount.Call(address(router), abi.encodeCall(PositionRouter.exit, (order)));
    }

    /// @notice The fill the router announced, read from the recorded logs.
    /// @return fill The fill.
    function _exited() internal returns (PositionRouter.Fill memory fill) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 index = 0; index < logs.length; index++) {
            if (
                logs[index].emitter == address(router)
                    && logs[index].topics[0] == PositionRouter.Exited.selector
            ) {
                (, fill) = abi.decode(
                    logs[index].data, (PositionRouter.ExitOrder, PositionRouter.Fill)
                );
                return fill;
            }
        }
        revert("no exit was announced");
    }

    /// @notice From the freeze the same transaction reverts whole, with the hook's error inside the
    ///         manager's, and the account keeps its dollars.
    function testFork_theSameTransactionRevertsAtTheFreeze() public {
        vm.warp(announcesAt);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                HOOK,
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(FreezeHook.Frozen.selector, yesKey.toId(), announcesAt),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        vm.prank(owner);
        account.execute(_batch(1));
        assertEq(dollar.balanceOf(address(account)), DOLLARS);
    }

    /// @notice The batch: approve exactly the dollars, then enter the yes world for the account.
    /// @param minShares The floor.
    /// @return calls The batch.
    function _batch(uint256 minShares) internal view returns (BatchAccount.Call[] memory calls) {
        calls = new BatchAccount.Call[](2);
        calls[0] = BatchAccount.Call(
            address(dollar), abi.encodeCall(IERC20.approve, (address(router), DOLLARS))
        );
        calls[1] = BatchAccount.Call(
            address(router),
            abi.encodeCall(
                PositionRouter.enter,
                (marketId, true, DOLLARS, minShares, address(account), vm.getBlockTimestamp())
            )
        );
    }

    /// @notice Opens a pool at a price and seeds it a fifth either side from fabricated collateral.
    /// @param key The pool.
    /// @param sqrtPriceX96 Its opening price.
    /// @param liquidity The position's liquidity.
    function _seed(PoolKey memory key, uint160 sqrtPriceX96, uint128 liquidity) internal {
        PoolModifyLiquidityTest seeder = new PoolModifyLiquidityTest(manager);
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        uint256[2] memory amounts = [uint256(100e18), 200_000e6];
        for (uint256 index = 0; index < 2; index++) {
            IERC20 collateral = vaults[index].COLLATERAL();
            deal(address(collateral), address(this), amounts[index]);
            collateral.approve(address(vaults[index]), amounts[index]);
            vaults[index].splitPosition(amounts[index]);
            vaults[index].YES().approve(address(seeder), type(uint256).max);
            vaults[index].NO().approve(address(seeder), type(uint256).max);
        }
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
}
