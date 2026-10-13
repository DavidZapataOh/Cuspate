// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ConditionalPoolsCaller} from "../unit/ConditionalPools.t.sol";

/// @title ConditionalPoolsFuzzTest
/// @notice The starting price round-trips exactly wherever the exact answer is known in closed
///         form: a square price whose decimals differ by an even count has a root that is a whole
///         multiple of 2**96, and its inverse has a root of 2**96 divided by that multiple. Both
///         ranges of the computation, both currency orders, and every decimal count up to 18 are
///         reached; the expected root is derived from the inputs, never from the code under test.
contract ConditionalPoolsFuzzTest is Test {
    /// @notice Two addresses in a known order, clear of the chain's precompiles.
    address internal constant LOW = address(0x1000000000000000000000000000000000000000);
    address internal constant HIGH = address(0x2000000000000000000000000000000000000000);

    /// @notice One in the pool's Q64.96 format.
    uint256 internal constant Q96 = 1 << 96;

    ConditionalPoolsCaller internal caller;

    /// @notice The caller the library is reached through.
    function setUp() public {
        caller = new ConditionalPoolsCaller();
    }

    /// @notice A base worth k**2 of the quote, with the quote carrying 2m more decimals and the price
    ///         written with 2n fractional digits, opens at exactly k * 10**m * 2**96.
    /// @param k The square root of the price.
    /// @param baseDecimals The base's decimals.
    /// @param m Half the quote's extra decimals.
    /// @param n Half the price's fractional digits.
    function testFuzz_aSquarePriceIsExact(uint256 k, uint8 baseDecimals, uint8 m, uint8 n) public {
        baseDecimals = uint8(bound(baseDecimals, 0, 18));
        m = uint8(bound(m, 0, (18 - baseDecimals) / 2));
        n = uint8(bound(n, 0, 9));
        k = bound(k, 1, (TickMath.MAX_SQRT_PRICE - 1) / (10 ** m * Q96));
        PoolKey memory key = _pair(baseDecimals, baseDecimals + 2 * m);
        uint160 root = caller.sqrtPriceX96(key, IERC20Metadata(LOW), k * k * 100 ** n, 2 * n);
        assertEq(root, k * 10 ** m * Q96);
    }

    /// @notice The same base as the second currency, its quote carrying 2m more decimals, opens at
    ///         exactly the floor of 2**96 / (k * 10**m).
    /// @param k The square root of the price.
    /// @param baseDecimals The base's decimals.
    /// @param m Half the quote's extra decimals.
    /// @param n Half the price's fractional digits.
    function testFuzz_anInverseSquarePriceIsExact(uint256 k, uint8 baseDecimals, uint8 m, uint8 n)
        public
    {
        baseDecimals = uint8(bound(baseDecimals, 0, 18));
        m = uint8(bound(m, 0, (18 - baseDecimals) / 2));
        n = uint8(bound(n, 0, 9));
        k = bound(k, 1, (uint256(1) << 63) / 10 ** m);
        PoolKey memory key = _pair(baseDecimals + 2 * m, baseDecimals);
        uint160 root = caller.sqrtPriceX96(key, IERC20Metadata(HIGH), k * k * 100 ** n, 2 * n);
        assertEq(root, Q96 / (k * 10 ** m));
    }

    /// @notice A hookless pool of two tokens at known addresses.
    /// @param lowDecimals The first currency's decimals.
    /// @param highDecimals The second currency's decimals.
    /// @return key The pool.
    function _pair(uint8 lowDecimals, uint8 highDecimals) internal returns (PoolKey memory key) {
        deployCodeTo(
            "PositionToken.sol:PositionToken",
            abi.encode("low", "LOW", lowDecimals, address(this)),
            LOW
        );
        deployCodeTo(
            "PositionToken.sol:PositionToken",
            abi.encode("high", "HIGH", highDecimals, address(this)),
            HIGH
        );
        key = PoolKey(Currency.wrap(LOW), Currency.wrap(HIGH), 3000, 60, IHooks(address(0)));
    }
}
