// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PositionVault} from "./PositionVault.sol";

/// @title ConditionalPools
/// @notice The pools a market trades in. Each world is priced on its own: the yes leg of the
///         underlying trades against the yes leg of the dollar, and the no leg against the no leg,
///         so a pool's price is the underlying's value in that world alone. A third pool pairs the
///         dollar's two legs: one of each always merges into a dollar, so its price is the dollar
///         value of a yes-dollar, the implied probability of yes, counting invalid as half (each leg
///         redeems half under an invalid outcome). This library names those pools, turns a value in
///         whole tokens into the price a pool opens at, and reads the yes-dollar's price back.
library ConditionalPools {
    using PoolIdLibrary for PoolKey;

    /// @notice The fee every market pool charges, in hundredths of a basis point.
    uint24 internal constant FEE = 3000;

    /// @notice The tick spacing that goes with that fee.
    int24 internal constant TICK_SPACING = 60;

    /// @notice One dollar, the unit a yes-dollar's price is written in: 18 decimals.
    uint256 internal constant ONE = 1e18;

    /// @notice One in the pool's Q64.96 format.
    uint256 private constant Q96 = 1 << 96;

    /// @notice The largest power of ten a word holds.
    uint256 private constant MAX_EXPONENT = 77;

    /// @notice Thrown when a price's square root falls outside the range a pool can hold, or the
    ///         price cannot be scaled to raw units at all.
    /// @param price The price given.
    /// @param priceDecimals Its decimals.
    error PriceOutOfRange(uint256 price, uint8 priceDecimals);

    /// @notice Thrown when a yes-dollar price is not strictly between nothing and one dollar: the
    ///         pool cannot open at a certainty.
    /// @param price The price given, 18-decimal.
    error YesDollarPriceOutOfRange(uint256 price);

    /// @notice Thrown when the token priced is neither of the pool's currencies.
    /// @param base The token given.
    error NotInPool(IERC20Metadata base);

    /// @notice A market's two pools: yes against yes, and no against no, each with its currencies
    ///         in the order the pool manager requires.
    /// @param underlyingVault The vault over the market's underlying.
    /// @param dollarVault The vault over the market's dollar.
    /// @param hooks The hook both pools use.
    /// @return yes The pool of the yes legs.
    /// @return no The pool of the no legs.
    function keysOf(PositionVault underlyingVault, PositionVault dollarVault, IHooks hooks)
        internal
        view
        returns (PoolKey memory yes, PoolKey memory no)
    {
        yes = _key(address(underlyingVault.YES()), address(dollarVault.YES()), hooks);
        no = _key(address(underlyingVault.NO()), address(dollarVault.NO()), hooks);
    }

    /// @notice The price a pool opens at for `base` to be worth `price` of the other currency, in
    ///         whole tokens. The pool's price is in raw units of its second currency per raw unit of
    ///         its first, so the decimals of both are applied and, when `base` is the second
    ///         currency, the price is inverted. The result is the floor of the exact square root
    ///         whenever the raw price is below 2**64, and within 2**32 of it above that.
    /// @param key The pool.
    /// @param base The token being priced; one of the pool's currencies.
    /// @param price Its value in the other currency, scaled by `priceDecimals`.
    /// @param priceDecimals How many of `price`'s digits are fractional.
    /// @return The square root of the pool's price, as a Q64.96 the pool can be initialised at.
    function sqrtPriceX96(
        PoolKey memory key,
        IERC20Metadata base,
        uint256 price,
        uint8 priceDecimals
    ) internal view returns (uint160) {
        address token0 = Currency.unwrap(key.currency0);
        address token1 = Currency.unwrap(key.currency1);
        if (address(base) != token0 && address(base) != token1) {
            revert NotInPool(base);
        }
        uint256 decimals0 = IERC20Metadata(token0).decimals();
        uint256 decimals1 = IERC20Metadata(token1).decimals();
        if (priceDecimals + decimals0 + decimals1 > MAX_EXPONENT) {
            revert PriceOutOfRange(price, priceDecimals);
        }
        // The raw price, token1 per token0, as the fraction num / den.
        (bool scaled, uint256 scaledPrice) =
            Math.tryMul(price, 10 ** (address(base) == token0 ? decimals1 : decimals0));
        if (!scaled) {
            revert PriceOutOfRange(price, priceDecimals);
        }
        uint256 unit = 10 ** (priceDecimals + (address(base) == token0 ? decimals0 : decimals1));
        (uint256 num, uint256 den) =
            address(base) == token0 ? (scaledPrice, unit) : (unit, scaledPrice);
        if (den == 0 || num / den >= 1 << 128) {
            revert PriceOutOfRange(price, priceDecimals);
        }
        uint256 root = _sqrtOf(num, den);
        if (root < TickMath.MIN_SQRT_PRICE || root >= TickMath.MAX_SQRT_PRICE) {
            revert PriceOutOfRange(price, priceDecimals);
        }
        return SafeCast.toUint160(root);
    }

    /// @notice The pool of a market's two dollar legs, yes against no, in the order the pool manager
    ///         requires, at the market fee and spacing.
    /// @param dollarVault The vault over the market's dollar.
    /// @param hooks The pool's hook.
    /// @return The pool.
    function probabilityKeyOf(PositionVault dollarVault, IHooks hooks)
        internal
        view
        returns (PoolKey memory)
    {
        return _key(address(dollarVault.YES()), address(dollarVault.NO()), hooks);
    }

    /// @notice The price the probability pool opens at for a yes-dollar to be worth `price` dollars,
    ///         that is `price / (ONE - price)` no-dollars. The currency order comes from the vault,
    ///         never from the caller. Every price strictly between nothing and one dollar has a root
    ///         inside the pool's range: the ratio stays below 2**64.
    /// @param dollarVault The vault whose legs the pool pairs.
    /// @param price The yes-dollar's price in dollars, 18-decimal.
    /// @return The square root of the pool's price, as a Q64.96 the pool can be initialised at.
    function sqrtPriceAtYesDollarPrice(PositionVault dollarVault, uint256 price)
        internal
        view
        returns (uint160)
    {
        if (price == 0 || price >= ONE) {
            revert YesDollarPriceOutOfRange(price);
        }
        return SafeCast.toUint160(
            _yesFirst(dollarVault) ? _sqrtOf(price, ONE - price) : _sqrtOf(ONE - price, price)
        );
    }

    /// @notice The yes-dollar's price in dollars at a sqrt price of the vault's probability pool:
    ///         the implied probability of yes, counting invalid as half. Rounded down in both
    ///         currency orders, so it never overstates; it lies in [0, ONE), reaching 0 at the
    ///         pool's extreme but never ONE, and a consumer still guards any division by it or by
    ///         ONE minus it.
    /// @param dollarVault The vault whose legs the pool pairs.
    /// @param sqrtPriceX96 The pool's sqrt price.
    /// @return The yes-dollar's price, 18-decimal.
    function yesDollarPriceAt(PositionVault dollarVault, uint160 sqrtPriceX96)
        internal
        view
        returns (uint256)
    {
        // The pool's price, no-dollars per yes-dollar or the inverse, in Q96. With the yes-dollar
        // first the result rises with it, so it is rounded down; second, the result falls as it
        // rises, so it is rounded up. Either way the reading is never above the exact value.
        if (_yesFirst(dollarVault)) {
            uint256 price = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, Q96);
            return FullMath.mulDiv(price, ONE, price + Q96);
        }
        uint256 inverse = FullMath.mulDivRoundingUp(sqrtPriceX96, sqrtPriceX96, Q96);
        return FullMath.mulDiv(Q96, ONE, inverse + Q96);
    }

    /// @notice The yes-dollar's price at the probability pool's current spot price, read from the
    ///         pool manager, at the pool the vault and hook name. A spot price moves within one
    ///         transaction for the cost of the fees: this reading is for display and for consumers
    ///         off chain, and no decision on chain may rest on it.
    /// @param manager The pool manager.
    /// @param dollarVault The vault whose legs the pool pairs.
    /// @param hooks The pool's hook.
    /// @return The yes-dollar's price, 18-decimal.
    function yesDollarPriceOf(IPoolManager manager, PositionVault dollarVault, IHooks hooks)
        internal
        view
        returns (uint256)
    {
        (uint160 sqrtPriceX96,,,) =
            StateLibrary.getSlot0(manager, probabilityKeyOf(dollarVault, hooks).toId());
        return yesDollarPriceAt(dollarVault, sqrtPriceX96);
    }

    /// @notice Whether the vault's yes leg sorts before its no leg.
    /// @param dollarVault The vault.
    /// @return Whether it does.
    function _yesFirst(PositionVault dollarVault) private view returns (bool) {
        return address(dollarVault.YES()) < address(dollarVault.NO());
    }

    /// @notice The floor of the square root of num / den in Q64.96, computed in two ranges: below
    ///         2**64 the ratio shifted left by 192 bits fits a word; above it only by 128, and the
    ///         root is shifted the remaining 32 bits after it is taken. Callers bound num / den
    ///         below 2**128 and den above zero.
    /// @param num The numerator.
    /// @param den The denominator.
    /// @return The root.
    function _sqrtOf(uint256 num, uint256 den) private pure returns (uint256) {
        return num / den < 1 << 64
            ? Math.sqrt(FullMath.mulDiv(num, 1 << 192, den))
            : Math.sqrt(FullMath.mulDiv(num, 1 << 128, den)) << 32;
    }

    /// @notice A pool of two tokens, sorted, at the market fee and spacing.
    /// @param a One token.
    /// @param b The other.
    /// @param hooks The pool's hook.
    /// @return The pool.
    function _key(address a, address b, IHooks hooks) private pure returns (PoolKey memory) {
        (address low, address high) = a < b ? (a, b) : (b, a);
        return PoolKey({
            currency0: Currency.wrap(low),
            currency1: Currency.wrap(high),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: hooks
        });
    }
}
