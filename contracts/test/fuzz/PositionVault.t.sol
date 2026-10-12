// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {TestCollateral} from "../unit/PositionVault.t.sol";

/// @title PositionVaultFuzzTest
/// @notice Holding one of each leg is holding the collateral: splitting and merging back returns
///         exactly what went in, for any amount, whole or in parts.
contract PositionVaultFuzzTest is Test {
    address internal holder = makeAddr("holder");

    TestCollateral internal collateral;
    PositionVault internal vault;

    /// @notice A vault over a test collateral.
    function setUp() public {
        collateral = new TestCollateral();
        vault = new PositionVault(IERC20(address(collateral)), keccak256("a market"));
        vm.prank(holder);
        collateral.approve(address(vault), type(uint256).max);
    }

    /// @notice Splitting everything and merging everything returns exactly the input.
    /// @param amount Any amount a collateral can hold.
    function testFuzz_splitThenMergeReturnsTheExactInput(uint256 amount) public {
        collateral.mint(holder, amount);
        vm.startPrank(holder);
        vault.splitPosition(amount);
        vault.mergePositions(amount);
        vm.stopPrank();
        _assertReturnedExactly(amount);
    }

    /// @notice Merging back in two parts returns exactly the input too.
    /// @param amount Any amount a collateral can hold.
    /// @param part How much of it to merge first.
    function testFuzz_mergeInPartsReturnsTheExactInput(uint256 amount, uint256 part) public {
        part = bound(part, 0, amount);
        collateral.mint(holder, amount);
        vm.startPrank(holder);
        vault.splitPosition(amount);
        vault.mergePositions(part);
        vault.mergePositions(amount - part);
        vm.stopPrank();
        _assertReturnedExactly(amount);
    }

    /// @notice The holder has its collateral back and no leg, and the vault holds nothing.
    /// @param amount What the holder started with.
    function _assertReturnedExactly(uint256 amount) private view {
        assertEq(collateral.balanceOf(holder), amount);
        assertEq(collateral.balanceOf(address(vault)), 0);
        assertEq(vault.YES().balanceOf(holder), 0);
        assertEq(vault.NO().balanceOf(holder), 0);
        assertEq(vault.YES().totalSupply(), 0);
        assertEq(vault.NO().totalSupply(), 0);
    }
}
