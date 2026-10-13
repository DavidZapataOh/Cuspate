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
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {FreezeHook} from "../../src/FreezeHook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {PositionRouter} from "../../src/PositionRouter.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {IPermit2Calls, IQuoterCalls} from "./ConditionalPoolsFork.t.sol";
import {BatchAccount} from "./PositionRouterFork.t.sol";

/// @notice The deployed Monday Trade price feed this test reads.
interface IStockOracle {
    /// @notice The latest round for a symbol's id.
    /// @param priceId The keccak256 of the upper-case symbol.
    /// @return price The price, 8 decimals.
    /// @return bestBid The best bid, 8 decimals.
    /// @return bestAsk The best ask, 8 decimals.
    /// @return feedUpdateTimestamp When the feed last changed.
    /// @return publishedAt When the round was written.
    /// @return roundId The round.
    /// @return session 0 unknown, 1 pre-market, 2 regular, 3 post-market, 4 overnight, 5 closed.
    function latestPrice(bytes32 priceId)
        external
        view
        returns (
            int128 price,
            int128 bestBid,
            int128 bestAsk,
            uint64 feedUpdateTimestamp,
            uint64 publishedAt,
            uint80 roundId,
            uint8 session
        );
}

/// @notice The part of the deployed quoter this test calls for an exact output.
interface IQuoterExactOutput {
    /// @notice What buying an exact amount in one pool would cost.
    /// @param params The quote; its amount is the output wanted.
    /// @return amountIn The input needed.
    /// @return gasEstimate The gas the swap would use.
    function quoteExactOutputSingle(IQuoterCalls.QuoteExactSingleParams memory params)
        external
        returns (uint256 amountIn, uint256 gasEstimate);
}

/// @notice The part of the deployed Universal Router this test calls.
interface IUniversalRouterCalls {
    /// @notice Runs a list of commands.
    /// @param commands One byte per command.
    /// @param inputs One encoded input per command.
    /// @param deadline The latest timestamp the call may run at.
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline)
        external
        payable;
}

/// @title CoherenceForkTest
/// @notice A market's three pools imply a price for the underlying, p * V_yes + (1 - p) * V_no, and
///         a keeper keeps it near the underlying's spot price, read from the venue's price feed, on
///         the chain as deployed at a pinned block. The keeper is an atomic batch account holding
///         inventory; it corrects legs that are too rich or too cheap in one batch, ends flat, is
///         clipped by its inventory and by the market's cap, and stays still when the feed is
///         stale or closed or the market frozen. This file is the reference the keeper service is
///         ported from; its literals are recorded for that port.
contract CoherenceForkTest is Test {
    using PoolIdLibrary for PoolKey;

    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    /// @notice A block at which the feed's session is closed and its round only 81 s old: the
    ///         session rule alone keeps the keeper still.
    uint256 internal constant CLOSED_BLOCK = 110_034_800;

    /// @notice The hook's address: exactly the before-initialise and before-swap permissions.
    address internal constant HOOK =
        address(uint160(0x4444 << 144) | Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    /// @notice The band the keeper leaves alone, 18 decimals: the pools' fee, the level's, impact
    ///         at a correction's size, the feed's age and the venue's quote fee (see the plan).
    uint256 internal constant BAND = 0.01e18;

    /// @notice The oldest round the keeper acts on, from its publication: about 2.5 heartbeats.
    uint256 internal constant MAX_AGE = 1500;

    /// @notice The feed's id for the underlying.
    bytes32 internal constant MU = keccak256("MU");

    /// @notice The Universal Router's command and the v4 actions this test uses.
    bytes1 internal constant V4_SWAP = 0x10;
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant TAKE_ALL = 0x0f;

    /// @notice The Universal Router's single-pool exact-input swap, decoded by it as one struct.
    /// @param poolKey The pool.
    /// @param zeroForOne Whether the first currency is sold.
    /// @param amountIn How much is sold.
    /// @param amountOutMinimum The floor.
    /// @param hookData Data for the hook.
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    /// @notice What a keeper step did.
    enum Action {
        Idle,
        Rich,
        Cheap
    }

    /// @notice A correction, its size and every floor, all from quotes on the state it runs on.
    /// @param rich Whether the legs are rich (sell them) or cheap (buy them).
    /// @param shares The shares each world's leg is corrected by.
    /// @param yesOut The yes-dollars (rich) or yes-world dollars spent (cheap).
    /// @param noOut The no-dollars (rich) or no-world dollars spent (cheap).
    /// @param level The surplus dollar leg sold in the probability pool.
    /// @param levelOut What the level pays.
    struct Correction {
        bool rich;
        uint256 shares;
        uint256 yesOut;
        uint256 noOut;
        uint256 level;
        uint256 levelOut;
    }

    address internal keeperOwner = makeAddr("keeper owner");
    address internal sealer = makeAddr("sealer");
    address internal guardian = makeAddr("guardian");
    address internal whale = makeAddr("whale");

    IPoolManager internal manager;
    IQuoterCalls internal quoter;
    IPermit2Calls internal permit2;
    IStockOracle internal oracle;
    IUniversalRouterCalls internal universalRouter;
    IERC20 internal underlying;
    IERC20 internal dollar;
    MarketFactory internal factory;
    ThresholdRegistry internal registry;
    FreezeHook internal hook;
    PositionRouter internal router;
    BatchAccount internal keeper;

    bytes32 internal eventId;
    uint64 internal announcesAt;
    bytes32 internal marketId;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;
    PoolKey internal yesKey;
    PoolKey internal noKey;
    PoolKey internal probabilityKey;

    /// @notice The venue and the protocol at the pinned block.
    function setUp() public {
        // The address book is read by chain, so the chain is set before the pinned block is read.
        vm.chainId(PRODUCTION_CHAIN);
        _deployAt(AddressBook.pinnedBlock());
    }

    /// @notice Opened coherent with the feed, the pools imply exactly its price, to the rounding of
    ///         the opening prices; the world prices and the implied price are recorded for the port.
    function testFork_thePoolsImplyTheFeedsPrice() public {
        _market(10e18, 100_000e6);
        (int128 price,,,,,,) = oracle.latestPrice(MU);
        assertEq(price, 106_938_500_000, "the feed's price at the pinned block");
        assertEq(_worldPrice(yesKey, true), 1_099_999_999_999_999_999_988, "the yes world's price");
        assertEq(_worldPrice(noKey, false), 1_023_462_499_999_999_999_999, "the no world's price");
        assertEq(_impliedPrice(), 1_069_384_999_999_999_999_992, "the implied price");
        // The literals above are the vectors the keeper service is checked against: the opening
        // prices round down by a few units in the eighteenth decimal, and so does the implied price.
        assertEq(ConditionalPools.yesDollarPriceOf(manager, dollarVault, IHooks(HOOK)), 0.6e18);
        assertEq(
            _probability(), ConditionalPools.yesDollarPriceOf(manager, dollarVault, IHooks(HOOK))
        );
    }

    /// @notice Rich legs: a whale buys both worlds' shares; with inventory and room enough, one
    ///         correction (one block) brings the implied price back to the band's upper edge, never
    ///         below the feed's ask, and the keeper ends flat.
    function testFork_richLegsAreCorrectedInOneBlock() public {
        _market(10e18, 1_000_000e6);
        _whaleBuys(2_500e6);
        uint256 upper = _upper();
        assertGt(_impliedPrice(), upper, "the whale did not make the legs rich");
        assertEq(uint8(_keeperStep(type(uint256).max)), uint8(Action.Rich));
        uint256 implied = _impliedPrice();
        assertLe(implied, upper, "the correction left the legs rich");
        assertGe(implied, _ask(), "the correction went past the feed's ask");
        assertApproxEqRel(implied, upper, 1e12, "the correction went further than the band's edge");
        _assertFlat();
    }

    /// @notice Cheap legs: a whale sells both worlds' shares; one correction brings the implied price
    ///         up to the band's lower edge, never above the feed's bid, and the keeper ends flat.
    function testFork_cheapLegsAreCorrectedInOneBlock() public {
        _market(10e18, 1_000_000e6);
        _whaleSells(2e18);
        uint256 lower = _lower();
        assertLt(_impliedPrice(), lower, "the whale did not make the legs cheap");
        assertEq(uint8(_keeperStep(type(uint256).max)), uint8(Action.Cheap));
        uint256 implied = _impliedPrice();
        assertGe(implied, lower, "the correction left the legs cheap");
        assertLe(implied, _bid(), "the correction went past the feed's bid");
        assertApproxEqRel(implied, lower, 1e12, "the correction went further than the band's edge");
        _assertFlat();
    }

    /// @notice Clipped by inventory: each correction spends its whole capped size, and the implied
    ///         price moves strictly toward the band without crossing it.
    function testFork_aClippedCorrectionMovesStrictlyTowardTheBand() public {
        _market(10e18, 1_000_000e6);
        _whaleBuys(2_500e6);
        uint256 upper = _upper();
        uint256 before = _impliedPrice();
        for (uint256 step = 0; step < 2; step++) {
            assertEq(uint8(_keeperStep(0.1e18)), uint8(Action.Rich));
            uint256 after_ = _impliedPrice();
            assertLt(after_, before, "a clipped correction did not move the price down");
            assertGt(after_, upper, "a clipped correction crossed into the band");
            before = after_;
            _assertFlat();
        }
    }

    /// @notice Clipped by the market's cap: a rich correction splits the underlying, and splits only
    ///         the room the underlying vault has left.
    function testFork_aCorrectionIsClippedByTheCap() public {
        _market(0.05e18, 1_000_000e6);
        _whaleBuys(2_500e6);
        uint256 room = underlyingVault.CAP() - underlyingVault.YES().totalSupply();
        assertGt(room, 0);
        assertEq(uint8(_keeperStep(type(uint256).max)), uint8(Action.Rich));
        assertEq(
            underlyingVault.YES().totalSupply(),
            underlyingVault.CAP(),
            "the correction did not use the room"
        );
        assertGt(_impliedPrice(), _upper(), "the cap did not bind");
    }

    /// @notice A pool moved between the quotes and the send: the batch's floors refuse it whole,
    ///         the keeper's inventory is unchanged and the router holds nothing.
    function testFork_aMovedPoolRevertsTheWholeCorrection() public {
        _market(10e18, 1_000_000e6);
        _whaleBuys(2_500e6);
        Correction memory correction = _sizeRich(_upper(), type(uint256).max);
        BatchAccount.Call[] memory calls = _richBatch(correction);
        // Someone sells the yes share first, lowering what the keeper's sale fetches.
        _sellShare(address(underlyingVault.YES()), 0.2e18);
        uint256 shares = underlying.balanceOf(address(keeper));
        uint256 dollars = dollar.balanceOf(address(keeper));
        vm.expectPartialRevert(PositionRouter.TooLittleOut.selector);
        vm.prank(keeperOwner);
        keeper.execute(calls);
        assertEq(underlying.balanceOf(address(keeper)), shares);
        assertEq(dollar.balanceOf(address(keeper)), dollars);
        assertEq(dollarVault.YES().balanceOf(address(router)), 0);
    }

    /// @notice A round older than the limit keeps the keeper still; at the limit it acts.
    function testFork_aStaleFeedKeepsTheKeeperStill() public {
        _market(10e18, 1_000_000e6);
        _whaleBuys(2_500e6);
        (,,,, uint64 publishedAt,,) = oracle.latestPrice(MU);
        vm.warp(publishedAt + MAX_AGE + 1);
        uint256 before = _impliedPrice();
        assertEq(uint8(_keeperStep(type(uint256).max)), uint8(Action.Idle));
        assertEq(_impliedPrice(), before);
        vm.warp(publishedAt + MAX_AGE);
        assertEq(uint8(_keeperStep(type(uint256).max)), uint8(Action.Rich));
    }

    /// @notice A frozen market keeps the keeper still: every batch would revert on the hook.
    function testFork_aFrozenMarketKeepsTheKeeperStill() public {
        _market(10e18, 1_000_000e6);
        _whaleBuys(2_500e6);
        vm.prank(guardian);
        hook.freezeNow(marketId);
        assertEq(uint8(_keeperStep(type(uint256).max)), uint8(Action.Idle));
    }

    /// @notice A closed session keeps the keeper still, at a block where the round is only 81 s old,
    ///         so the session rule alone decides.
    function testFork_aClosedSessionKeepsTheKeeperStill() public {
        _deployAt(CLOSED_BLOCK);
        (,,,, uint64 publishedAt,, uint8 session) = oracle.latestPrice(MU);
        assertEq(session, 5, "the feed is not closed at the named block");
        assertLe(
            vm.getBlockTimestamp() - publishedAt, MAX_AGE, "the round is stale, not only closed"
        );
        _market(10e18, 1_000_000e6);
        _whaleBuys(2_500e6);
        assertEq(uint8(_keeperStep(type(uint256).max)), uint8(Action.Idle));
    }

    // --- The keeper ------------------------------------------------------------------------

    /// @notice One step of the reference keeper: idle unless the feed is open, fresh and sane and the
    ///         market is not frozen; otherwise one correction toward the band's nearer edge, sized
    ///         by simulation and clipped by inventory and room, with every floor from quotes.
    /// @param clip The largest correction, in shares, this step may make.
    /// @return What it did.
    function _keeperStep(uint256 clip) internal returns (Action) {
        (int128 price, int128 bid, int128 ask,, uint64 publishedAt,, uint8 session) =
            oracle.latestPrice(MU);
        if (
            session == 0 || session == 5 || price <= 0 || bid <= 0 || bid > ask
                || vm.getBlockTimestamp() - publishedAt > MAX_AGE
                || vm.getBlockTimestamp() >= hook.freezesAt(yesKey.toId())
        ) {
            return Action.Idle;
        }
        uint256 implied = _impliedPrice();
        if (implied > _upper()) {
            BatchAccount.Call[] memory calls = _richBatch(_sizeRich(_upper(), clip));
            vm.prank(keeperOwner);
            keeper.execute(calls);
            return Action.Rich;
        }
        if (implied < _lower()) {
            BatchAccount.Call[] memory calls = _cheapBatch(_sizeCheap(_lower(), clip));
            vm.prank(keeperOwner);
            keeper.execute(calls);
            return Action.Cheap;
        }
        return Action.Idle;
    }

    /// @notice The smallest rich correction that brings the implied price into the band, within the
    ///         keeper's underlying, the vault's room and the clip; the whole allowance if even that
    ///         does not reach it, so a clipped correction moves the price as far as it can.
    /// @param target The band's upper edge.
    /// @param clip The largest size allowed.
    /// @return The correction.
    function _sizeRich(uint256 target, uint256 clip) internal returns (Correction memory) {
        uint256 high = _min(
            _min(
                underlying.balanceOf(address(keeper)),
                underlyingVault.CAP() - underlyingVault.YES().totalSupply()
            ),
            clip
        );
        if (_impliedAfter(_richBatch(_quoteRich(high))) > target) {
            return _quoteRich(high);
        }
        uint256 low = 0;
        while (high - low > 1) {
            uint256 middle = (low + high) / 2;
            if (_impliedAfter(_richBatch(_quoteRich(middle))) <= target) {
                high = middle;
            } else {
                low = middle;
            }
        }
        return _quoteRich(high);
    }

    /// @notice The smallest cheap correction that brings the implied price into the band, within the
    ///         keeper's dollars, the dollar vault's room and the clip; the whole allowance if even
    ///         that does not reach it.
    /// @param target The band's lower edge.
    /// @param clip The largest size allowed.
    /// @return The correction.
    function _sizeCheap(uint256 target, uint256 clip) internal returns (Correction memory) {
        uint256 high = _min(2e18, clip);
        // The allowance in shares: shrink until the dollars it needs fit the keeper and the room.
        while (high > 0 && !_affordable(_quoteCheap(high))) {
            high = high / 2;
        }
        if (_impliedAfter(_cheapBatch(_quoteCheap(high))) < target) {
            return _quoteCheap(high);
        }
        uint256 low = 0;
        while (high - low > 1) {
            uint256 middle = (low + high) / 2;
            if (_impliedAfter(_cheapBatch(_quoteCheap(middle))) >= target) {
                high = middle;
            } else {
                low = middle;
            }
        }
        return _quoteCheap(high);
    }

    /// @notice Whether a cheap correction's dollars fit the keeper's balance and the vault's room.
    /// @param c The correction.
    /// @return Whether they do.
    function _affordable(Correction memory c) internal view returns (bool) {
        uint256 spend = c.yesOut + c.noOut;
        return spend <= dollar.balanceOf(address(keeper))
            && spend <= dollarVault.CAP() - dollarVault.YES().totalSupply();
    }

    /// @notice A rich correction's amounts, from quotes on the current state: the three pools are
    ///         disjoint, so each sale and the level quote independently.
    /// @param shares The shares sold in each world.
    /// @return correction The correction.
    function _quoteRich(uint256 shares) internal returns (Correction memory correction) {
        correction.rich = true;
        correction.shares = shares;
        correction.yesOut = _quoteIn(yesKey, address(underlyingVault.YES()), shares);
        correction.noOut = _quoteIn(noKey, address(underlyingVault.NO()), shares);
        // The no world's exit keeps the yes-dollars; whichever leg is larger is levelled.
        (uint256 surplus, address sold) = correction.yesOut > correction.noOut
            ? (correction.yesOut - correction.noOut, address(dollarVault.YES()))
            : (correction.noOut - correction.yesOut, address(dollarVault.NO()));
        (correction.level, correction.levelOut) = _levelFor(surplus, sold);
    }

    /// @notice A cheap correction's amounts: the dollars that buy exactly `shares` in each world,
    ///         from the quoter's exact-output quotes, and the level of the dollar leg left over.
    /// @param shares The shares bought in each world.
    /// @return correction The correction.
    function _quoteCheap(uint256 shares) internal returns (Correction memory correction) {
        correction.shares = shares;
        correction.yesOut = _quoteOut(yesKey, address(dollarVault.YES()), shares);
        correction.noOut = _quoteOut(noKey, address(dollarVault.NO()), shares);
        // Entering the yes world keeps no-dollars, entering the no world keeps yes-dollars.
        (uint256 surplus, address sold) = correction.yesOut > correction.noOut
            ? (correction.yesOut - correction.noOut, address(dollarVault.NO()))
            : (correction.noOut - correction.yesOut, address(dollarVault.YES()));
        (correction.level, correction.levelOut) = _levelFor(surplus, sold);
    }

    /// @notice The largest amount of a surplus dollar leg whose sale leaves the two legs level, and
    ///         what it pays: equality is reached near `surplus / (1 + price)`, found by bisection.
    /// @param surplus The surplus.
    /// @param sold The leg sold.
    /// @return level The amount.
    /// @return levelOut What it pays.
    function _levelFor(uint256 surplus, address sold)
        internal
        returns (uint256 level, uint256 levelOut)
    {
        (uint256 low, uint256 high) = (0, surplus);
        while (low < high) {
            uint256 middle = (low + high + 1) / 2;
            if (surplus - middle >= _quoteIn(probabilityKey, sold, middle)) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        level = low;
        levelOut = level == 0 ? 0 : _quoteIn(probabilityKey, sold, level);
    }

    /// @notice The rich batch: split the underlying, sell the yes shares for yes-dollars, sell the no
    ///         shares keeping those yes-dollars, level and merge; every swap behind its quote.
    /// @param c The correction.
    /// @return calls The batch.
    function _richBatch(Correction memory c)
        internal
        view
        returns (BatchAccount.Call[] memory calls)
    {
        calls = new BatchAccount.Call[](7);
        calls[0] = _call(
            address(underlying),
            abi.encodeCall(IERC20.approve, (address(underlyingVault), c.shares))
        );
        calls[1] = _call(
            address(underlyingVault), abi.encodeCall(PositionVault.splitPosition, (c.shares))
        );
        calls[2] = _call(
            address(underlyingVault.YES()),
            abi.encodeCall(IERC20.approve, (address(router), c.shares))
        );
        calls[3] = _call(
            address(router),
            abi.encodeCall(
                PositionRouter.exit,
                (_exitOrder(address(keeper), true, c.shares, 0, c.yesOut, false, 0, 0))
            )
        );
        calls[4] = _call(
            address(underlyingVault.NO()),
            abi.encodeCall(IERC20.approve, (address(router), c.shares))
        );
        calls[5] = _call(
            address(dollarVault.YES()), abi.encodeCall(IERC20.approve, (address(router), c.yesOut))
        );
        calls[6] = _call(
            address(router),
            abi.encodeCall(
                PositionRouter.exit,
                (_exitOrder(
                        address(keeper),
                        false,
                        c.shares,
                        c.yesOut,
                        c.noOut,
                        c.noOut > c.yesOut,
                        c.level,
                        c.levelOut
                    ))
            )
        );
    }

    /// @notice The cheap batch: buy the shares in each world, merge them into the underlying, level
    ///         the dollar leg left over through the Universal Router, and merge the dollar legs.
    /// @param c The correction.
    /// @return calls The batch.
    function _cheapBatch(Correction memory c)
        internal
        view
        returns (BatchAccount.Call[] memory calls)
    {
        bool noDollarsLeft = c.yesOut > c.noOut;
        address sold = noDollarsLeft ? address(dollarVault.NO()) : address(dollarVault.YES());
        uint256 levelled = noDollarsLeft ? c.noOut + c.levelOut : c.yesOut + c.levelOut;
        calls = new BatchAccount.Call[](8);
        calls[0] = _call(
            address(dollar), abi.encodeCall(IERC20.approve, (address(router), c.yesOut + c.noOut))
        );
        calls[1] = _call(
            address(router),
            abi.encodeCall(
                PositionRouter.enter,
                (marketId, true, c.yesOut, c.shares, address(keeper), _deadline())
            )
        );
        calls[2] = _call(
            address(router),
            abi.encodeCall(
                PositionRouter.enter,
                (marketId, false, c.noOut, c.shares, address(keeper), _deadline())
            )
        );
        calls[3] = _call(
            address(underlyingVault), abi.encodeCall(PositionVault.mergePositions, (c.shares))
        );
        calls[4] = _call(sold, abi.encodeCall(IERC20.approve, (address(permit2), c.level)));
        calls[5] = _call(
            address(permit2),
            abi.encodeCall(
                IPermit2Calls.approve,
                (sold, address(universalRouter), SafeCast.toUint160(c.level), type(uint48).max)
            )
        );
        calls[6] = _call(address(universalRouter), _levelCall(sold, c.level, c.levelOut));
        calls[7] =
            _call(address(dollarVault), abi.encodeCall(PositionVault.mergePositions, (levelled)));
    }

    /// @notice The Universal Router call that sells `amount` of a dollar leg for the other in the
    ///         probability pool, paid from the keeper's Permit2 allowance, its output floored.
    /// @param sold The leg sold.
    /// @param amount How much.
    /// @param minOut The floor.
    /// @return The call.
    function _levelCall(address sold, uint256 amount, uint256 minOut)
        internal
        view
        returns (bytes memory)
    {
        bool zeroForOne = Currency.unwrap(probabilityKey.currency0) == sold;
        address bought = zeroForOne
            ? Currency.unwrap(probabilityKey.currency1)
            : Currency.unwrap(probabilityKey.currency0);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: probabilityKey,
                zeroForOne: zeroForOne,
                amountIn: SafeCast.toUint128(amount),
                amountOutMinimum: SafeCast.toUint128(minOut),
                hookData: bytes("")
            })
        );
        params[1] = abi.encode(sold, amount);
        params[2] = abi.encode(bought, minOut);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL), params);
        return abi.encodeCall(
            IUniversalRouterCalls.execute, (abi.encodePacked(V4_SWAP), inputs, _deadline())
        );
    }

    /// @notice The implied price after a batch, run on a copy of the state that is then discarded.
    /// @param calls The batch.
    /// @return implied The implied price, or 0 if the batch would revert.
    function _impliedAfter(BatchAccount.Call[] memory calls) internal returns (uint256 implied) {
        uint256 snapshot = vm.snapshotState();
        vm.prank(keeperOwner);
        try keeper.execute(calls) {
            implied = _impliedPrice();
        } catch {
            implied = 0;
        }
        vm.revertToState(snapshot);
    }

    // --- The arithmetic --------------------------------------------------------------------

    /// @notice The price the pools imply for one share of the underlying, in dollars, 18 decimals:
    ///         p * V_yes + (1 - p) * V_no. A spot reading, for display and keepers only.
    /// @return The implied price.
    function _impliedPrice() internal view returns (uint256) {
        uint256 probability = _probability();
        return (probability
                * _worldPrice(yesKey, true)
                + (1e18 - probability)
                * _worldPrice(noKey, false)) / 1e18;
    }

    /// @notice The yes-dollar's price in dollars from the probability pool's spot price, as the
    ///         protocol's library computes it (checked equal to it outside any loop): rounded down,
    ///         the inverse rounded up when the yes-dollar is the second currency. Computed here so
    ///         the keeper's searches do not call the library inside a loop.
    /// @return The price, 18 decimals.
    function _probability() internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(manager, probabilityKey.toId());
        if (Currency.unwrap(probabilityKey.currency0) == address(dollarVault.YES())) {
            uint256 price = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96);
            return FullMath.mulDiv(price, 1e18, price + (1 << 96));
        }
        uint256 inverse = FullMath.mulDivRoundingUp(sqrtPriceX96, sqrtPriceX96, 1 << 96);
        return FullMath.mulDiv(1 << 96, 1e18, inverse + (1 << 96));
    }

    /// @notice A world pool's price in whole world dollars per whole world share, 18 decimals, from
    ///         its sqrt price: shares have 18 decimals and dollars 6, so a raw price r is r * 1e12
    ///         whole, and 1e30 * r at 18 decimals; with the share second the raw price is inverted.
    /// @param key The pool.
    /// @param yes The world.
    /// @return The price.
    function _worldPrice(PoolKey memory key, bool yes) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(manager, key.toId());
        address share = yes ? address(underlyingVault.YES()) : address(underlyingVault.NO());
        if (Currency.unwrap(key.currency0) == share) {
            return
                FullMath.mulDiv(FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96), 1e30, 1 << 96);
        }
        return FullMath.mulDiv(FullMath.mulDiv(1e30, 1 << 96, sqrtPriceX96), 1 << 96, sqrtPriceX96);
    }

    // --- The fixture -----------------------------------------------------------------------

    /// @notice Forks a block, finds the venue and the feed, and deploys the protocol and a keeper.
    /// @param blockNumber The block.
    function _deployAt(uint256 blockNumber) internal {
        vm.chainId(PRODUCTION_CHAIN);
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), blockNumber);
        manager = IPoolManager(AddressBook.thirdParty("poolManager", 0));
        quoter = IQuoterCalls(AddressBook.thirdParty("v4Quoter", 0));
        permit2 = IPermit2Calls(AddressBook.thirdParty("permit2", 0));
        oracle = IStockOracle(AddressBook.thirdParty("stockOracle", 0));
        universalRouter = IUniversalRouterCalls(AddressBook.thirdParty("universalRouter", 0));
        underlying = IERC20(AddressBook.thirdParty("collateral", 0));
        dollar = IERC20(AddressBook.thirdParty("dollar", 0));
        assertGt(
            address(manager).code.length * address(oracle).code.length
                * address(universalRouter).code.length,
            0,
            "no code at a recorded contract at this block: if the endpoint no longer serves it, re-pin"
        );
        factory = new MarketFactory();
        registry = new ThresholdRegistry();
        OptimisticResolver resolver = new OptimisticResolver(
            factory, registry, sealer, makeAddr("arbiter"), dollar, 2, 1, 1, 1, 1
        );
        deployCodeTo("FreezeHook.sol:FreezeHook", abi.encode(manager, resolver, guardian), HOOK);
        hook = FreezeHook(HOOK);
        router = new PositionRouter(hook);
        keeper = new BatchAccount(keeperOwner);
        announcesAt = uint64(vm.getBlockTimestamp()) + 1 days;
        vm.prank(sealer);
        eventId = registry.seal(
            ThresholdRegistry.Threshold({
                value: 1,
                decimals: 0,
                announcesAt: announcesAt,
                deadline: announcesAt + 1 days,
                terms: "coherence"
            })
        );
    }

    /// @notice A market with the given room above its seeding, its three pools opened coherent with
    ///         the feed's price at the pinned block (1,100 / 1,023.4625 / 0.6 imply 1,069.385) and
    ///         seeded, and a keeper holding two shares and five thousand dollars.
    /// @param underlyingRoom The underlying vault's room above the seeding.
    /// @param dollarRoom The dollar vault's room above the seeding.
    function _market(uint256 underlyingRoom, uint256 dollarRoom) internal {
        uint256 seededShares = 30e18;
        uint256 seededDollars = 45_000e6;
        marketId = factory.createMarket(
            underlying,
            dollar,
            eventId,
            address(hook.RESOLVER()),
            seededShares + underlyingRoom,
            seededDollars + dollarRoom
        );
        hook.register(marketId, eventId);
        (underlyingVault, dollarVault) = factory.markets(marketId);
        (yesKey, noKey) = ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(HOOK));
        probabilityKey = ConditionalPools.probabilityKeyOf(dollarVault, IHooks(HOOK));
        _split(address(this), seededShares, seededDollars);
        PoolModifyLiquidityTest seeder = new PoolModifyLiquidityTest(manager);
        address[4] memory legs = [
            address(underlyingVault.YES()),
            address(underlyingVault.NO()),
            address(dollarVault.YES()),
            address(dollarVault.NO())
        ];
        for (uint256 index = 0; index < 4; index++) {
            IERC20(legs[index]).approve(address(seeder), type(uint256).max);
        }
        _open(
            seeder,
            yesKey,
            ConditionalPools.sqrtPriceX96(yesKey, IERC20Metadata(legs[0]), 1100, 0),
            1e16
        );
        _open(
            seeder,
            noKey,
            ConditionalPools.sqrtPriceX96(noKey, IERC20Metadata(legs[1]), 10_234_625, 4),
            1e16
        );
        _open(
            seeder,
            probabilityKey,
            ConditionalPools.sqrtPriceAtYesDollarPrice(dollarVault, 0.6e18),
            1e11
        );
        deal(address(underlying), address(keeper), 2e18);
        deal(address(dollar), address(keeper), 5_000e6);
    }

    /// @notice Opens a pool at a price and seeds it a fifth either side.
    /// @param seeder The liquidity router.
    /// @param key The pool.
    /// @param sqrtPriceX96 The price.
    /// @param liquidity The liquidity.
    function _open(
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

    /// @notice A whale enters both worlds with the same dollars, buying shares and raising both
    ///         world prices.
    /// @param dollars The dollars per world.
    function _whaleBuys(uint256 dollars) internal {
        deal(address(dollar), whale, 2 * dollars);
        vm.startPrank(whale);
        dollar.approve(address(router), 2 * dollars);
        router.enter(marketId, true, dollars, 1, whale, _deadline());
        router.enter(marketId, false, dollars, 1, whale, _deadline());
        vm.stopPrank();
    }

    /// @notice A whale splits the underlying and sells both legs, lowering both world prices.
    /// @param shares The shares per world.
    function _whaleSells(uint256 shares) internal {
        _split(whale, shares, 0);
        _sellShare(address(underlyingVault.YES()), shares);
        _sellShare(address(underlyingVault.NO()), shares);
    }

    /// @notice The whale sells a share leg in its pool through the router's exit with no kept leg,
    ///         splitting the underlying first if it holds too little.
    /// @param share The leg.
    /// @param shares How much.
    function _sellShare(address share, uint256 shares) internal {
        if (IERC20(share).balanceOf(whale) < shares) {
            _split(whale, shares, 0);
        }
        bool yes = share == address(underlyingVault.YES());
        vm.startPrank(whale);
        IERC20(share).approve(address(router), shares);
        router.exit(_exitOrder(whale, yes, shares, 0, 1, false, 0, 0));
        vm.stopPrank();
    }

    /// @notice An exit order.
    /// @param recipient Who receives the dollars and remainders.
    /// @param yes The world.
    /// @param shares The shares.
    /// @param kept The kept leg.
    /// @param minOut The sale's floor.
    /// @param levelSellsWorldDollar Which leg the level sells.
    /// @param level The level.
    /// @param minLevelOut Its floor.
    /// @return The order.
    function _exitOrder(
        address recipient,
        bool yes,
        uint256 shares,
        uint256 kept,
        uint256 minOut,
        bool levelSellsWorldDollar,
        uint256 level,
        uint256 minLevelOut
    ) internal view returns (PositionRouter.ExitOrder memory) {
        return PositionRouter.ExitOrder({
            marketId: marketId,
            yes: yes,
            shares: shares,
            kept: kept,
            minOut: minOut,
            levelSellsWorldDollar: levelSellsWorldDollar,
            level: level,
            minLevelOut: minLevelOut,
            recipient: recipient,
            deadline: _deadline()
        });
    }

    /// @notice Gives an account legs by splitting fabricated collateral.
    /// @param holder The account.
    /// @param shares The underlying to split.
    /// @param dollars The dollars to split.
    function _split(address holder, uint256 shares, uint256 dollars) internal {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        uint256[2] memory amounts = [shares, dollars];
        for (uint256 index = 0; index < 2; index++) {
            if (amounts[index] == 0) continue;
            IERC20 collateral = vaults[index].COLLATERAL();
            deal(address(collateral), holder, collateral.balanceOf(holder) + amounts[index]);
            vm.startPrank(holder);
            collateral.approve(address(vaults[index]), amounts[index]);
            vaults[index].splitPosition(amounts[index]);
            vm.stopPrank();
        }
    }

    /// @notice The keeper holds no leg beyond dust: the rich batch ends within a few wei, the cheap
    ///         one within the dollars one raw unit of the quote buys.
    function _assertFlat() internal view {
        assertLe(
            underlyingVault.YES().balanceOf(address(keeper)), 1e10, "the keeper kept yes shares"
        );
        assertLe(underlyingVault.NO().balanceOf(address(keeper)), 1e10, "the keeper kept no shares");
        assertLe(dollarVault.YES().balanceOf(address(keeper)), 10, "the keeper kept yes-dollars");
        assertLe(dollarVault.NO().balanceOf(address(keeper)), 10, "the keeper kept no-dollars");
    }

    /// @notice An exact-input quote.
    /// @param key The pool.
    /// @param input What is sold.
    /// @param amount How much.
    /// @return out What it pays.
    function _quoteIn(PoolKey memory key, address input, uint256 amount)
        internal
        returns (uint256 out)
    {
        if (amount == 0) return 0;
        (out,) = quoter.quoteExactInputSingle(
            IQuoterCalls.QuoteExactSingleParams(
                key, Currency.unwrap(key.currency0) == input, SafeCast.toUint128(amount), ""
            )
        );
    }

    /// @notice An exact-output quote: the input that buys exactly `amount` of the other currency.
    /// @param key The pool.
    /// @param input What is paid.
    /// @param amount How much is bought.
    /// @return needed The input needed.
    function _quoteOut(PoolKey memory key, address input, uint256 amount)
        internal
        returns (uint256 needed)
    {
        (needed,) = IQuoterExactOutput(address(quoter))
            .quoteExactOutputSingle(
                IQuoterCalls.QuoteExactSingleParams(
                    key, Currency.unwrap(key.currency0) == input, SafeCast.toUint128(amount), ""
                )
            );
    }

    /// @notice A batch call.
    /// @param target The target.
    /// @param data The calldata.
    /// @return The call.
    function _call(address target, bytes memory data)
        internal
        pure
        returns (BatchAccount.Call memory)
    {
        return BatchAccount.Call(target, data);
    }

    /// @notice The band's upper edge: the feed's ask plus the band, 18 decimals.
    /// @return The edge.
    function _upper() internal view returns (uint256) {
        return _ask() * (1e18 + BAND) / 1e18;
    }

    /// @notice The band's lower edge: the feed's bid less the band, 18 decimals.
    /// @return The edge.
    function _lower() internal view returns (uint256) {
        return _bid() * (1e18 - BAND) / 1e18;
    }

    /// @notice The feed's ask at 18 decimals.
    /// @return The ask.
    function _ask() internal view returns (uint256) {
        (,, int128 ask,,,,) = oracle.latestPrice(MU);
        return SafeCast.toUint256(int256(ask)) * 1e10;
    }

    /// @notice The feed's bid at 18 decimals.
    /// @return The bid.
    function _bid() internal view returns (uint256) {
        (, int128 bid,,,,,) = oracle.latestPrice(MU);
        return SafeCast.toUint256(int256(bid)) * 1e10;
    }

    /// @notice A deadline for this block.
    /// @return The deadline.
    function _deadline() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// @notice The smaller of two amounts.
    /// @param a One.
    /// @param b The other.
    /// @return The smaller.
    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
