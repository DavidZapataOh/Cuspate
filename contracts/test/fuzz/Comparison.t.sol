// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";

/// @title ComparisonTest
/// @notice The resolver's exact comparison of a figure with a threshold agrees with two independent
///         references over every value and every pair of decimals up to eighteen, and never reverts.
contract ComparisonTest is Test {
    OptimisticResolver internal resolver;

    /// @notice A resolver, only for its comparison.
    function setUp() public {
        resolver = new OptimisticResolver(
            MarketFactory(address(1)),
            ThresholdRegistry(address(1)),
            address(1),
            IERC20(address(1)),
            1,
            1
        );
    }

    /// @notice Where cross-multiplying cannot overflow, the comparison is the cross-multiplied one.
    /// @param figure The figure.
    /// @param figureDecimals Its decimals.
    /// @param value The threshold.
    /// @param valueDecimals Its decimals.
    function testFuzz_agreesWithCrossMultiplication(
        int128 figure,
        uint8 figureDecimals,
        int128 value,
        uint8 valueDecimals
    ) public view {
        figureDecimals = uint8(bound(figureDecimals, 0, 18));
        valueDecimals = uint8(bound(valueDecimals, 0, 18));
        bool expected = int256(figure) * int256(10) ** valueDecimals
            > int256(value) * int256(10) ** figureDecimals;
        assertEq(resolver.isGreater(figure, figureDecimals, value, valueDecimals), expected);
    }

    /// @notice Over every value, the comparison agrees with scaling the side with fewer decimals, an
    ///         overflow of that scaling decided by the sign of what overflowed.
    /// @param figure The figure.
    /// @param figureDecimals Its decimals.
    /// @param value The threshold.
    /// @param valueDecimals Its decimals.
    function testFuzz_agreesWithTheScaledComparison(
        int256 figure,
        uint8 figureDecimals,
        int256 value,
        uint8 valueDecimals
    ) public view {
        figureDecimals = uint8(bound(figureDecimals, 0, 18));
        valueDecimals = uint8(bound(valueDecimals, 0, 18));
        assertEq(
            resolver.isGreater(figure, figureDecimals, value, valueDecimals),
            _scaled(figure, figureDecimals, value, valueDecimals)
        );
    }

    /// @notice The reference: scale the side with fewer decimals up; if that overflows, the scaled
    ///         side's magnitude exceeds anything the other side can hold, so its sign decides.
    /// @param figure The figure.
    /// @param figureDecimals Its decimals.
    /// @param value The threshold.
    /// @param valueDecimals Its decimals.
    /// @return Whether the figure is greater.
    function _scaled(int256 figure, uint8 figureDecimals, int256 value, uint8 valueDecimals)
        internal
        pure
        returns (bool)
    {
        if (figureDecimals >= valueDecimals) {
            int256 factor = int256(10) ** (figureDecimals - valueDecimals);
            if (value > type(int256).max / factor) return false;
            if (value < type(int256).min / factor) return true;
            return figure > value * factor;
        }
        int256 scale = int256(10) ** (valueDecimals - figureDecimals);
        if (figure > type(int256).max / scale) return true;
        if (figure < type(int256).min / scale) return false;
        return figure * scale > value;
    }
}
