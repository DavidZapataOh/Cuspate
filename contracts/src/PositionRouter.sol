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
/// @notice Buys a share of the underlying only in one world, in one call: "buy the stock only if
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

    /// @notice Sells through the pool manager. Kept apart so a venue interface can take its place.
    /// @param swap The swap.
    /// @return The output amount.
    function _swap(Swap memory swap) private returns (uint256) {
        return abi.decode(POOL_MANAGER.unlock(abi.encode(swap)), (uint256));
    }
}
