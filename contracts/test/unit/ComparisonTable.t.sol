// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";

/// @title ComparisonTableTest
/// @notice The resolver's exact comparison at the extremes of every value and of decimals, against
///         answers computed off chain in exact rational arithmetic.
contract ComparisonTableTest is Test {
    OptimisticResolver internal resolver;

    /// @notice A resolver, only for its comparison.
    function setUp() public {
        resolver = new OptimisticResolver(
            MarketFactory(address(1)),
            ThresholdRegistry(address(1)),
            address(1),
            address(1),
            IERC20(address(1)),
            1,
            1,
            1,
            1,
            1
        );
    }

    /// @notice The extremes of every value against each other, at the extremes of decimals, against
    ///         answers computed off chain in exact rational arithmetic.
    function test_extremesMatchExactArithmetic() public view {
        assertEq(resolver.isGreater(type(int256).min, 0, type(int256).min, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 0, type(int256).min, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 18, type(int256).min, 0), true);
        assertEq(resolver.isGreater(type(int256).min, 18, type(int256).min, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 3, type(int256).min, 11), false);
        assertEq(resolver.isGreater(type(int256).min, 0, type(int256).min + 1, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 0, type(int256).min + 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 18, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(type(int256).min, 18, type(int256).min + 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 3, type(int256).min + 1, 11), false);
        assertEq(resolver.isGreater(type(int256).min, 0, -1, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 0, -1, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 18, -1, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 18, -1, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 3, -1, 11), false);
        assertEq(resolver.isGreater(type(int256).min, 0, 0, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 0, 0, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 18, 0, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 18, 0, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 3, 0, 11), false);
        assertEq(resolver.isGreater(type(int256).min, 0, 1, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 0, 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 18, 1, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 18, 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 3, 1, 11), false);
        assertEq(resolver.isGreater(type(int256).min, 0, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 0, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 18, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 18, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 3, type(int256).max - 1, 11), false);
        assertEq(resolver.isGreater(type(int256).min, 0, type(int256).max, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 0, type(int256).max, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 18, type(int256).max, 0), false);
        assertEq(resolver.isGreater(type(int256).min, 18, type(int256).max, 18), false);
        assertEq(resolver.isGreater(type(int256).min, 3, type(int256).max, 11), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, type(int256).min, 0), true);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, type(int256).min, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, type(int256).min, 0), true);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, type(int256).min, 18), true);
        assertEq(resolver.isGreater(type(int256).min + 1, 3, type(int256).min, 11), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, type(int256).min + 1, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, type(int256).min + 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, type(int256).min + 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 3, type(int256).min + 1, 11), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, -1, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, -1, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, -1, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, -1, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 3, -1, 11), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, 0, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, 0, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, 0, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, 0, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 3, 0, 11), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, 1, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, 1, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 3, 1, 11), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 3, type(int256).max - 1, 11), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, type(int256).max, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 0, type(int256).max, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, type(int256).max, 0), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 18, type(int256).max, 18), false);
        assertEq(resolver.isGreater(type(int256).min + 1, 3, type(int256).max, 11), false);
        assertEq(resolver.isGreater(-1, 0, type(int256).min, 0), true);
        assertEq(resolver.isGreater(-1, 0, type(int256).min, 18), true);
        assertEq(resolver.isGreater(-1, 18, type(int256).min, 0), true);
        assertEq(resolver.isGreater(-1, 18, type(int256).min, 18), true);
        assertEq(resolver.isGreater(-1, 3, type(int256).min, 11), true);
        assertEq(resolver.isGreater(-1, 0, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(-1, 0, type(int256).min + 1, 18), true);
        assertEq(resolver.isGreater(-1, 18, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(-1, 18, type(int256).min + 1, 18), true);
        assertEq(resolver.isGreater(-1, 3, type(int256).min + 1, 11), true);
        assertEq(resolver.isGreater(-1, 0, -1, 0), false);
        assertEq(resolver.isGreater(-1, 0, -1, 18), false);
        assertEq(resolver.isGreater(-1, 18, -1, 0), true);
        assertEq(resolver.isGreater(-1, 18, -1, 18), false);
        assertEq(resolver.isGreater(-1, 3, -1, 11), false);
        assertEq(resolver.isGreater(-1, 0, 0, 0), false);
        assertEq(resolver.isGreater(-1, 0, 0, 18), false);
        assertEq(resolver.isGreater(-1, 18, 0, 0), false);
        assertEq(resolver.isGreater(-1, 18, 0, 18), false);
        assertEq(resolver.isGreater(-1, 3, 0, 11), false);
        assertEq(resolver.isGreater(-1, 0, 1, 0), false);
        assertEq(resolver.isGreater(-1, 0, 1, 18), false);
        assertEq(resolver.isGreater(-1, 18, 1, 0), false);
        assertEq(resolver.isGreater(-1, 18, 1, 18), false);
        assertEq(resolver.isGreater(-1, 3, 1, 11), false);
        assertEq(resolver.isGreater(-1, 0, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(-1, 0, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(-1, 18, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(-1, 18, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(-1, 3, type(int256).max - 1, 11), false);
        assertEq(resolver.isGreater(-1, 0, type(int256).max, 0), false);
        assertEq(resolver.isGreater(-1, 0, type(int256).max, 18), false);
        assertEq(resolver.isGreater(-1, 18, type(int256).max, 0), false);
        assertEq(resolver.isGreater(-1, 18, type(int256).max, 18), false);
        assertEq(resolver.isGreater(-1, 3, type(int256).max, 11), false);
        assertEq(resolver.isGreater(0, 0, type(int256).min, 0), true);
        assertEq(resolver.isGreater(0, 0, type(int256).min, 18), true);
        assertEq(resolver.isGreater(0, 18, type(int256).min, 0), true);
        assertEq(resolver.isGreater(0, 18, type(int256).min, 18), true);
        assertEq(resolver.isGreater(0, 3, type(int256).min, 11), true);
        assertEq(resolver.isGreater(0, 0, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(0, 0, type(int256).min + 1, 18), true);
        assertEq(resolver.isGreater(0, 18, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(0, 18, type(int256).min + 1, 18), true);
        assertEq(resolver.isGreater(0, 3, type(int256).min + 1, 11), true);
        assertEq(resolver.isGreater(0, 0, -1, 0), true);
        assertEq(resolver.isGreater(0, 0, -1, 18), true);
        assertEq(resolver.isGreater(0, 18, -1, 0), true);
        assertEq(resolver.isGreater(0, 18, -1, 18), true);
        assertEq(resolver.isGreater(0, 3, -1, 11), true);
        assertEq(resolver.isGreater(0, 0, 0, 0), false);
        assertEq(resolver.isGreater(0, 0, 0, 18), false);
        assertEq(resolver.isGreater(0, 18, 0, 0), false);
        assertEq(resolver.isGreater(0, 18, 0, 18), false);
        assertEq(resolver.isGreater(0, 3, 0, 11), false);
        assertEq(resolver.isGreater(0, 0, 1, 0), false);
        assertEq(resolver.isGreater(0, 0, 1, 18), false);
        assertEq(resolver.isGreater(0, 18, 1, 0), false);
        assertEq(resolver.isGreater(0, 18, 1, 18), false);
        assertEq(resolver.isGreater(0, 3, 1, 11), false);
        assertEq(resolver.isGreater(0, 0, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(0, 0, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(0, 18, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(0, 18, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(0, 3, type(int256).max - 1, 11), false);
        assertEq(resolver.isGreater(0, 0, type(int256).max, 0), false);
        assertEq(resolver.isGreater(0, 0, type(int256).max, 18), false);
        assertEq(resolver.isGreater(0, 18, type(int256).max, 0), false);
        assertEq(resolver.isGreater(0, 18, type(int256).max, 18), false);
        assertEq(resolver.isGreater(0, 3, type(int256).max, 11), false);
        assertEq(resolver.isGreater(1, 0, type(int256).min, 0), true);
        assertEq(resolver.isGreater(1, 0, type(int256).min, 18), true);
        assertEq(resolver.isGreater(1, 18, type(int256).min, 0), true);
        assertEq(resolver.isGreater(1, 18, type(int256).min, 18), true);
        assertEq(resolver.isGreater(1, 3, type(int256).min, 11), true);
        assertEq(resolver.isGreater(1, 0, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(1, 0, type(int256).min + 1, 18), true);
        assertEq(resolver.isGreater(1, 18, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(1, 18, type(int256).min + 1, 18), true);
        assertEq(resolver.isGreater(1, 3, type(int256).min + 1, 11), true);
        assertEq(resolver.isGreater(1, 0, -1, 0), true);
        assertEq(resolver.isGreater(1, 0, -1, 18), true);
        assertEq(resolver.isGreater(1, 18, -1, 0), true);
        assertEq(resolver.isGreater(1, 18, -1, 18), true);
        assertEq(resolver.isGreater(1, 3, -1, 11), true);
        assertEq(resolver.isGreater(1, 0, 0, 0), true);
        assertEq(resolver.isGreater(1, 0, 0, 18), true);
        assertEq(resolver.isGreater(1, 18, 0, 0), true);
        assertEq(resolver.isGreater(1, 18, 0, 18), true);
        assertEq(resolver.isGreater(1, 3, 0, 11), true);
        assertEq(resolver.isGreater(1, 0, 1, 0), false);
        assertEq(resolver.isGreater(1, 0, 1, 18), true);
        assertEq(resolver.isGreater(1, 18, 1, 0), false);
        assertEq(resolver.isGreater(1, 18, 1, 18), false);
        assertEq(resolver.isGreater(1, 3, 1, 11), true);
        assertEq(resolver.isGreater(1, 0, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(1, 0, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(1, 18, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(1, 18, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(1, 3, type(int256).max - 1, 11), false);
        assertEq(resolver.isGreater(1, 0, type(int256).max, 0), false);
        assertEq(resolver.isGreater(1, 0, type(int256).max, 18), false);
        assertEq(resolver.isGreater(1, 18, type(int256).max, 0), false);
        assertEq(resolver.isGreater(1, 18, type(int256).max, 18), false);
        assertEq(resolver.isGreater(1, 3, type(int256).max, 11), false);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, type(int256).min, 0), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, type(int256).min, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, type(int256).min, 0), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, type(int256).min, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 3, type(int256).min, 11), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, type(int256).min + 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, type(int256).min + 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 3, type(int256).min + 1, 11), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, -1, 0), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, -1, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, -1, 0), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, -1, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 3, -1, 11), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, 0, 0), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, 0, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, 0, 0), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, 0, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 3, 0, 11), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, 1, 0), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, 1, 0), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 3, 1, 11), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, type(int256).max - 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, type(int256).max - 1, 18), false);
        assertEq(resolver.isGreater(type(int256).max - 1, 3, type(int256).max - 1, 11), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, type(int256).max, 0), false);
        assertEq(resolver.isGreater(type(int256).max - 1, 0, type(int256).max, 18), true);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, type(int256).max, 0), false);
        assertEq(resolver.isGreater(type(int256).max - 1, 18, type(int256).max, 18), false);
        assertEq(resolver.isGreater(type(int256).max - 1, 3, type(int256).max, 11), true);
        assertEq(resolver.isGreater(type(int256).max, 0, type(int256).min, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 0, type(int256).min, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 18, type(int256).min, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 18, type(int256).min, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 3, type(int256).min, 11), true);
        assertEq(resolver.isGreater(type(int256).max, 0, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 0, type(int256).min + 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 18, type(int256).min + 1, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 18, type(int256).min + 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 3, type(int256).min + 1, 11), true);
        assertEq(resolver.isGreater(type(int256).max, 0, -1, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 0, -1, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 18, -1, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 18, -1, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 3, -1, 11), true);
        assertEq(resolver.isGreater(type(int256).max, 0, 0, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 0, 0, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 18, 0, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 18, 0, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 3, 0, 11), true);
        assertEq(resolver.isGreater(type(int256).max, 0, 1, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 0, 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 18, 1, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 18, 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 3, 1, 11), true);
        assertEq(resolver.isGreater(type(int256).max, 0, type(int256).max - 1, 0), true);
        assertEq(resolver.isGreater(type(int256).max, 0, type(int256).max - 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 18, type(int256).max - 1, 0), false);
        assertEq(resolver.isGreater(type(int256).max, 18, type(int256).max - 1, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 3, type(int256).max - 1, 11), true);
        assertEq(resolver.isGreater(type(int256).max, 0, type(int256).max, 0), false);
        assertEq(resolver.isGreater(type(int256).max, 0, type(int256).max, 18), true);
        assertEq(resolver.isGreater(type(int256).max, 18, type(int256).max, 0), false);
        assertEq(resolver.isGreater(type(int256).max, 18, type(int256).max, 18), false);
        assertEq(resolver.isGreater(type(int256).max, 3, type(int256).max, 11), true);
    }
}
