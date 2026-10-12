// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";
import {TestCollateral} from "./PositionVault.t.sol";
import {TestStock} from "./MarketFactory.t.sol";

/// @title AccessTest
/// @notice A contract that a holder or a resolver calls gains none of their power: every check is
///         on the immediate caller, never on the account that started the transaction.
contract AccessTest is Test {
    bytes32 internal constant EVENT = keccak256("an event");
    uint256 internal constant AMOUNT = 101e6;

    address internal resolver = makeAddr("resolver");
    address internal holder = makeAddr("holder");
    address internal stranger = makeAddr("a contract the holder calls");

    MarketFactory internal factory;
    TestCollateral internal dollar;
    PositionVault internal vault;

    /// @notice A market whose dollar vault the holder has split into.
    function setUp() public {
        factory = new MarketFactory();
        dollar = new TestCollateral();
        bytes32 id = factory.createMarket(
            IERC20(address(new TestStock())), IERC20(address(dollar)), EVENT, resolver
        );
        (, vault) = factory.markets(id);
        dollar.mint(holder, AMOUNT);
        vm.startPrank(holder);
        dollar.approve(address(vault), AMOUNT);
        vault.splitPosition(AMOUNT);
        vm.stopPrank();
    }

    /// @notice A merge sent by a contract in the holder's transaction burns that contract's legs,
    ///         which it does not have, and leaves the holder's untouched.
    function test_RevertWhen_mergeCallerIsNotTheHolder() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, stranger, 0, AMOUNT
            )
        );
        vm.prank(stranger, holder);
        vault.mergePositions(AMOUNT);

        assertEq(vault.YES().balanceOf(holder), AMOUNT);
        assertEq(vault.NO().balanceOf(holder), AMOUNT);
        assertEq(dollar.balanceOf(address(vault)), AMOUNT);
    }

    /// @notice The same holds for a redemption after the outcome is reported.
    function test_RevertWhen_redeemCallerIsNotTheHolder() public {
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);

        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, stranger, 0, AMOUNT
            )
        );
        vm.prank(stranger, holder);
        vault.redeemPositions(AMOUNT, AMOUNT);

        assertEq(vault.YES().balanceOf(holder), AMOUNT);
        assertEq(dollar.balanceOf(address(vault)), AMOUNT);
    }

    /// @notice A report sent by a contract in the resolver's transaction lands under that
    ///         contract's own condition: the market stays unresolved, and its resolver can still
    ///         report.
    function test_aReportRelayedByTheResolverStaysTheRelayers() public {
        vm.prank(stranger, resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);
        assertEq(uint8(factory.outcomeOf(vault.CONDITION())), uint8(Outcome.Unresolved));

        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.No);
        assertEq(uint8(factory.outcomeOf(vault.CONDITION())), uint8(Outcome.No));
    }
}
