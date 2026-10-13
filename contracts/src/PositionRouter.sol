// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ConditionalPools} from "./ConditionalPools.sol";
import {FreezeHook} from "./FreezeHook.sol";
import {MarketFactory} from "./MarketFactory.sol";
import {PositionVault} from "./PositionVault.sol";

/// @title PositionRouter
/// @notice Enters and exits conditional positions. Entry buys a share of the underlying only in one
///         world, in one call: "buy the stock only if
///         the event happens; if not, keep your dollars". The caller's dollars are split into both
///         dollar legs; the chosen world's dollar leg is sold, in full, for that world's leg of the
///         underlying in the market's hooked pool; and the recipient receives that leg and every unit
///         of the other dollar leg. The pools touched are only those of the freeze hook, derived from
///         the market, so a frozen market cannot be entered.
/// @dev The payer is always the caller, never an argument, so an allowance left to this router can be
///      spent only by its owner. The router holds no funds and no state between calls and has no
///      owner; the guardian's freeze of a market is what stops entries into it.
contract PositionRouter is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    /// @notice The freeze hook whose pools this router trades in.
    FreezeHook public immutable HOOK;

    /// @notice The pool manager, read from the hook.
    IPoolManager public immutable POOL_MANAGER;

    /// @notice The market factory, read from the hook.
    MarketFactory public immutable FACTORY;

    /// @notice What the callback needs, passed through the pool manager rather than kept in storage.
    /// @param key The pool.
    /// @param input The dollar leg sold.
    /// @param output The underlying leg bought.
    /// @param amountIn How much is sold.
    /// @param recipient Who receives the output.
    struct Swap {
        PoolKey key;
        address input;
        address output;
        uint256 amountIn;
        address recipient;
    }

    /// @notice An exit: the position to close and how.
    /// @param marketId The market.
    /// @param yes The world of the underlying leg held.
    /// @param shares How much of that leg to sell; more than zero, so every exit meets the hook.
    /// @param kept How much of the other world's dollar leg to merge with; may be zero.
    /// @param minOut The least of the world's dollar leg to accept for the shares.
    /// @param levelSellsWorldDollar Whether the level sells the world's dollar leg (or the kept one).
    /// @param level How much of that leg to sell in the probability pool before merging; zero to skip.
    /// @param minLevelOut The least to accept for the level; non-zero exactly when the level is.
    /// @param recipient Who receives the dollars and any remainder; neither zero nor this router.
    /// @param deadline The latest timestamp the exit may run at.
    struct ExitOrder {
        bytes32 marketId;
        bool yes;
        uint256 shares;
        uint256 kept;
        uint256 minOut;
        bool levelSellsWorldDollar;
        uint256 level;
        uint256 minLevelOut;
        address recipient;
        uint256 deadline;
    }

    /// @notice What an exit filled.
    /// @param out The world's dollar leg the shares sold for.
    /// @param levelOut What the level sold for; zero without one.
    /// @param dollars The dollars merged and sent.
    /// @param yesLeft The yes-dollars sent back unmerged.
    /// @param noLeft The no-dollars sent back unmerged.
    struct Fill {
        uint256 out;
        uint256 levelOut;
        uint256 dollars;
        uint256 yesLeft;
        uint256 noLeft;
    }

    /// @notice Thrown when the hook given is the zero address.
    error ZeroAddress();

    /// @notice Thrown when the callback is called by anyone but the pool manager.
    /// @param caller Who called.
    error NotPoolManager(address caller);

    /// @notice Thrown when an entry arrives after its deadline.
    /// @param deadline The deadline.
    error Expired(uint256 deadline);

    /// @notice Thrown when an entry pays nothing.
    error ZeroAmount();

    /// @notice Thrown when an entry names no floor for what it receives.
    error NoFloor();

    /// @notice Thrown when the recipient is the zero address or the router itself.
    /// @param recipient The recipient given.
    error BadRecipient(address recipient);

    /// @notice Thrown when a market does not exist or its pools are not registered with the hook.
    /// @param marketId The market.
    error NotAMarket(bytes32 marketId);

    /// @notice Thrown when the pool would take only part of the input before its price limit.
    /// @param consumed What it would take.
    /// @param amountIn What was offered.
    error PartialFill(uint256 consumed, uint256 amountIn);

    /// @notice Thrown when the share received is below the caller's floor.
    /// @param out What the pool pays.
    /// @param minimum The floor.
    error TooLittleOut(uint256 out, uint256 minimum);

    /// @notice Thrown when a level and its floor are not both zero or both non-zero.
    /// @param level The level.
    /// @param minLevelOut Its floor.
    error LevelFloorMismatch(uint256 level, uint256 minLevelOut);

    /// @notice Thrown when a level exceeds the named leg's surplus over the other.
    /// @param level The level.
    /// @param surplus The surplus; zero when the named leg is not the larger.
    error LevelTooLarge(uint256 level, uint256 surplus);

    /// @notice A position was entered.
    /// @param marketId The market.
    /// @param payer Who paid the dollars.
    /// @param recipient Who received the position.
    /// @param yes Whether the share bought is the yes world's.
    /// @param dollars How many dollars were paid, and kept as the other world's dollar leg.
    /// @param shares How much of the underlying leg was bought.
    event Entered(
        bytes32 indexed marketId,
        address indexed payer,
        address indexed recipient,
        bool yes,
        uint256 dollars,
        uint256 shares
    );

    /// @notice A position was exited.
    /// @param marketId The market.
    /// @param holder Who held the position.
    /// @param recipient Who received the dollars and the remainders.
    /// @param order The exit as ordered.
    /// @param fill What it filled, every amount, so each pool's fee can be itemised.
    event Exited(
        bytes32 indexed marketId,
        address indexed holder,
        address indexed recipient,
        ExitOrder order,
        Fill fill
    );

    /// @notice Creates the router over one freeze hook; the pool manager and the factory are read from
    ///         it, so they can never disagree with it.
    /// @param hook The freeze hook.
    constructor(FreezeHook hook) {
        if (address(hook) == address(0)) {
            revert ZeroAddress();
        }
        HOOK = hook;
        POOL_MANAGER = hook.POOL_MANAGER();
        FACTORY = hook.FACTORY();
    }

    /// @notice Pays `dollars` of the market's dollar from the caller, who must have allowed this
    ///         router at least that much; splits them; sells all of the chosen world's dollar leg for
    ///         that world's leg of the underlying; and sends the recipient that leg and `dollars` of
    ///         the other world's dollar leg. Every check comes before any funds move.
    /// @param marketId The market.
    /// @param yes Whether to buy the share in the world where the event happens.
    /// @param dollars How many dollars to pay.
    /// @param minShares The least of the underlying leg to accept; the caller's protection against
    ///        the price moving, which nothing on chain can compute for it.
    /// @param recipient Who receives the position; neither zero nor this router.
    /// @param deadline The latest timestamp the entry may run at.
    /// @return shares How much of the underlying leg was bought.
    /// @custom:access anyone
    function enter(
        bytes32 marketId,
        bool yes,
        uint256 dollars,
        uint256 minShares,
        address recipient,
        uint256 deadline
    ) external returns (uint256 shares) {
        _check(dollars, minShares, recipient, deadline);
        (Swap memory swap, address kept) = _payAndSplit(marketId, yes, dollars, recipient);
        shares = _swap(swap);
        if (shares < minShares) {
            revert TooLittleOut(shares, minShares);
        }
        IERC20(kept).safeTransfer(recipient, dollars);
        // Emitted last because the amount bought is known only after the swap. The router keeps no
        // state, so a reentrant entry can only log its own true values, never alter this one's.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Entered(marketId, msg.sender, recipient, yes, dollars, shares);
    }

    /// @notice Closes a position before the freeze: takes the shares and the kept dollar leg from the
    ///         caller, sells the shares for the world's dollar leg, optionally sells part of whichever
    ///         dollar leg the order names in the probability pool, merges the smaller of the two dollar
    ///         legs into dollars, and sends the recipient the dollars and both remainders. Each swap
    ///         has its own floor; every check on the order comes before any funds move.
    /// @param order The exit.
    /// @return dollars The dollars merged and sent.
    /// @custom:access anyone
    function exit(ExitOrder calldata order) external returns (uint256 dollars) {
        _checkExit(order);
        (PositionVault underlyingVault, PositionVault dollarVault, PoolKey memory worldKey) =
            _poolsOf(order.marketId, order.yes);
        (address share, address worldDollar, address keptDollar) = order.yes
            ? (
                address(underlyingVault.YES()),
                address(dollarVault.YES()),
                address(dollarVault.NO())
            )
            : (address(underlyingVault.NO()), address(dollarVault.NO()), address(dollarVault.YES()));
        IERC20(share).safeTransferFrom(msg.sender, address(this), order.shares);
        if (order.kept > 0) {
            IERC20(keptDollar).safeTransferFrom(msg.sender, address(this), order.kept);
        }

        Fill memory fill;
        fill.out = _swap(Swap(worldKey, share, worldDollar, order.shares, address(this)));
        if (fill.out < order.minOut) {
            revert TooLittleOut(fill.out, order.minOut);
        }
        (uint256 world, uint256 kept) = _level(order, dollarVault, fill, worldDollar, keptDollar);
        _merge(order, dollarVault, fill, world, kept);
        // Emitted last because the amounts are known only after the swaps. The router keeps no
        // state, so a reentrant call can only log its own true values, never alter this one's.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Exited(order.marketId, msg.sender, order.recipient, order, fill);
        return fill.dollars;
    }

    /// @notice Runs one swap inside the pool manager's unlock: sells exactly the input, refusing a
    ///         partial fill, pays it in and sends the output to the recipient.
    /// @param data The encoded swap.
    /// @return The output amount, encoded.
    /// @custom:access pool manager
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) {
            revert NotPoolManager(msg.sender);
        }
        Swap memory swap = abi.decode(data, (Swap));
        bool zeroForOne = Currency.unwrap(swap.key.currency0) == swap.input;
        BalanceDelta delta = POOL_MANAGER.swap(
            swap.key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -SafeCast.toInt256(swap.amountIn),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 paid, int128 received) =
            zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        uint256 consumed = SafeCast.toUint256(-int256(paid));
        if (consumed != swap.amountIn) {
            revert PartialFill(consumed, swap.amountIn);
        }
        uint256 out = SafeCast.toUint256(int256(received));
        POOL_MANAGER.sync(Currency.wrap(swap.input));
        IERC20(swap.input).safeTransfer(address(POOL_MANAGER), swap.amountIn);
        // forge-lint: disable-next-line(unused-return)
        POOL_MANAGER.settle();
        POOL_MANAGER.take(Currency.wrap(swap.output), swap.recipient, out);
        return abi.encode(out);
    }

    /// @notice Refuses a malformed entry, before anything is read or moved.
    /// @param dollars How many dollars to pay.
    /// @param minShares The floor.
    /// @param recipient The recipient.
    /// @param deadline The deadline.
    function _check(uint256 dollars, uint256 minShares, address recipient, uint256 deadline)
        private
        view
    {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) {
            revert Expired(deadline);
        }
        if (dollars == 0) {
            revert ZeroAmount();
        }
        if (minShares == 0) {
            revert NoFloor();
        }
        if (recipient == address(0) || recipient == address(this)) {
            revert BadRecipient(recipient);
        }
    }

    /// @notice Refuses a market without registered pools, then pulls the caller's dollars, splits
    ///         them, and names the swap and the leg kept.
    /// @param marketId The market.
    /// @param yes The world bought.
    /// @param dollars How many dollars.
    /// @param recipient Who receives the position.
    /// @return swap The swap of the chosen world's dollar leg.
    /// @return kept The other world's dollar leg.
    function _payAndSplit(bytes32 marketId, bool yes, uint256 dollars, address recipient)
        private
        returns (Swap memory swap, address kept)
    {
        (PositionVault underlyingVault, PositionVault dollarVault) = FACTORY.markets(marketId);
        if (address(underlyingVault) == address(0)) {
            revert NotAMarket(marketId);
        }
        (PoolKey memory yesKey, PoolKey memory noKey) =
            ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(address(HOOK)));
        if (HOOK.freezesAt(yesKey.toId()) == 0) {
            revert NotAMarket(marketId);
        }

        IERC20 dollar = dollarVault.COLLATERAL();
        dollar.safeTransferFrom(msg.sender, address(this), dollars);
        dollar.forceApprove(address(dollarVault), dollars);
        dollarVault.splitPosition(dollars);

        if (yes) {
            swap = Swap(
                yesKey,
                address(dollarVault.YES()),
                address(underlyingVault.YES()),
                dollars,
                recipient
            );
            kept = address(dollarVault.NO());
        } else {
            swap = Swap(
                noKey, address(dollarVault.NO()), address(underlyingVault.NO()), dollars, recipient
            );
            kept = address(dollarVault.YES());
        }
    }

    /// @notice Refuses a malformed exit, before anything is read or moved.
    /// @param order The exit.
    function _checkExit(ExitOrder calldata order) private view {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > order.deadline) {
            revert Expired(order.deadline);
        }
        if (order.shares == 0) {
            revert ZeroAmount();
        }
        if (order.minOut == 0) {
            revert NoFloor();
        }
        if ((order.level == 0) != (order.minLevelOut == 0)) {
            revert LevelFloorMismatch(order.level, order.minLevelOut);
        }
        if (order.recipient == address(0) || order.recipient == address(this)) {
            revert BadRecipient(order.recipient);
        }
    }

    /// @notice A market's vaults and the pool of one world, refusing a market without registered
    ///         pools. The probability pool is registered with the others, so it needs no check.
    /// @param marketId The market.
    /// @param yes The world.
    /// @return underlyingVault The vault over the underlying.
    /// @return dollarVault The vault over the dollar.
    /// @return worldKey The world's pool.
    function _poolsOf(bytes32 marketId, bool yes)
        private
        view
        returns (PositionVault underlyingVault, PositionVault dollarVault, PoolKey memory worldKey)
    {
        (underlyingVault, dollarVault) = FACTORY.markets(marketId);
        if (address(underlyingVault) == address(0)) {
            revert NotAMarket(marketId);
        }
        (PoolKey memory yesKey, PoolKey memory noKey) =
            ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(address(HOOK)));
        if (HOOK.freezesAt(yesKey.toId()) == 0) {
            revert NotAMarket(marketId);
        }
        worldKey = yes ? yesKey : noKey;
    }

    /// @notice Sells the order's level of the leg it names in the probability pool, if any, within
    ///         that leg's surplus over the other, as computed from the amounts this exit holds.
    /// @param order The exit.
    /// @param dollarVault The vault over the dollar.
    /// @param fill The fill so far; its level output is written.
    /// @param worldDollar The world's dollar leg.
    /// @param keptDollar The other world's dollar leg.
    /// @return world The world's dollar leg held after the level.
    /// @return kept The other world's dollar leg held after the level.
    function _level(
        ExitOrder calldata order,
        PositionVault dollarVault,
        Fill memory fill,
        address worldDollar,
        address keptDollar
    ) private returns (uint256 world, uint256 kept) {
        (world, kept) = (fill.out, order.kept);
        if (order.level == 0) {
            return (world, kept);
        }
        (uint256 named, uint256 other) = order.levelSellsWorldDollar ? (world, kept) : (kept, world);
        uint256 surplus = named > other ? named - other : 0;
        if (order.level > surplus) {
            revert LevelTooLarge(order.level, surplus);
        }
        (address sold, address bought) =
            order.levelSellsWorldDollar ? (worldDollar, keptDollar) : (keptDollar, worldDollar);
        fill.levelOut = _swap(
            Swap(
                ConditionalPools.probabilityKeyOf(dollarVault, IHooks(address(HOOK))),
                sold,
                bought,
                order.level,
                address(this)
            )
        );
        if (fill.levelOut < order.minLevelOut) {
            revert TooLittleOut(fill.levelOut, order.minLevelOut);
        }
        if (order.levelSellsWorldDollar) {
            (world, kept) = (world - order.level, kept + fill.levelOut);
        } else {
            (world, kept) = (world + fill.levelOut, kept - order.level);
        }
    }

    /// @notice Merges the smaller of the two dollar legs into dollars and sends the recipient the
    ///         dollars and both remainders.
    /// @param order The exit.
    /// @param dollarVault The vault over the dollar.
    /// @param fill The fill; its dollars and remainders are written.
    /// @param world The world's dollar leg held.
    /// @param kept The other world's dollar leg held.
    function _merge(
        ExitOrder calldata order,
        PositionVault dollarVault,
        Fill memory fill,
        uint256 world,
        uint256 kept
    ) private {
        fill.dollars = world < kept ? world : kept;
        (uint256 yesDollars, uint256 noDollars) = order.yes ? (world, kept) : (kept, world);
        (fill.yesLeft, fill.noLeft) = (yesDollars - fill.dollars, noDollars - fill.dollars);
        if (fill.dollars > 0) {
            dollarVault.mergePositions(fill.dollars);
            dollarVault.COLLATERAL().safeTransfer(order.recipient, fill.dollars);
        }
        if (fill.yesLeft > 0) {
            IERC20(address(dollarVault.YES())).safeTransfer(order.recipient, fill.yesLeft);
        }
        if (fill.noLeft > 0) {
            IERC20(address(dollarVault.NO())).safeTransfer(order.recipient, fill.noLeft);
        }
    }

    /// @notice Sells through the pool manager. Kept apart so a venue interface can take its place.
    /// @param swap The swap.
    /// @return The output amount.
    function _swap(Swap memory swap) private returns (uint256) {
        return abi.decode(POOL_MANAGER.unlock(abi.encode(swap)), (uint256));
    }
}
