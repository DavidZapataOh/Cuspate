// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestnetDollar} from "../../src/testnet/TestnetDollar.sol";
import {TestnetStock} from "../../src/testnet/TestnetStock.sol";
import {TestnetOnly} from "../../src/testnet/TestnetOnly.sol";

/// @title TestnetTokensTest
/// @notice The test network's dollar and share: where they can exist, who mints them, and the drip
///         any visitor takes.
contract TestnetTokensTest is Test {
    address internal constant OWNER = address(0xA11CE);
    address internal constant USER = address(0xB0B);

    TestnetDollar internal dollar;
    TestnetStock internal stock;

    /// @notice Both tokens, on the test network's chain id.
    function setUp() public {
        vm.chainId(10_143);
        dollar = new TestnetDollar(OWNER);
        stock = new TestnetStock("Tesla test stock", "TSLA", OWNER);
    }

    /// @notice The dollar has the production dollar's decimals and the share a share's.
    function test_theDollarHasSixDecimalsAndTheStockEighteen() public view {
        assertEq(dollar.decimals(), 6);
        assertEq(stock.decimals(), 18);
        assertEq(stock.symbol(), "TSLA");
        assertEq(stock.name(), "Tesla test stock");
    }

    /// @notice Neither token can be created on the production chain.
    function test_RevertWhen_deployedOnAnotherChain() public {
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.NotATestChain.selector, 143));
        new TestnetDollar(OWNER);
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.NotATestChain.selector, 143));
        new TestnetStock("Tesla test stock", "TSLA", OWNER);
    }

    /// @notice A local chain is a test chain too.
    function test_deploysOnALocalChain() public {
        vm.chainId(31_337);
        assertEq(new TestnetDollar(OWNER).OWNER(), OWNER);
    }

    /// @notice A token with no owner could never be minted for seeding.
    function test_RevertWhen_constructedWithNoOwner() public {
        vm.expectRevert(TestnetOnly.ZeroOwner.selector);
        new TestnetDollar(address(0));
    }

    /// @notice The owner mints either token.
    function test_theOwnerMints() public {
        vm.prank(OWNER);
        dollar.mint(USER, 5e6);
        assertEq(dollar.balanceOf(USER), 5e6);
        vm.prank(OWNER);
        stock.mint(USER, 2e18);
        assertEq(stock.balanceOf(USER), 2e18);
    }

    /// @notice Nobody else mints.
    function test_RevertWhen_mintCallerIsNotTheOwner() public {
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.NotOwner.selector, USER));
        vm.prank(USER);
        dollar.mint(USER, 1);
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.NotOwner.selector, USER));
        vm.prank(USER);
        stock.mint(USER, 1);
    }

    /// @notice Anyone drips, and again only once the cooldown has passed.
    function test_anyoneDripsOncePerCooldown() public {
        vm.prank(USER);
        dollar.drip();
        assertEq(dollar.balanceOf(USER), dollar.DRIP());
        vm.prank(USER);
        stock.drip();
        assertEq(stock.balanceOf(USER), stock.DRIP());

        uint256 next = vm.getBlockTimestamp() + dollar.COOLDOWN();
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.TooSoon.selector, next));
        vm.prank(USER);
        dollar.drip();

        vm.warp(next);
        vm.prank(USER);
        dollar.drip();
        assertEq(dollar.balanceOf(USER), 2 * dollar.DRIP());
    }

    /// @notice A drip is a thousand test dollars, or one share, once a day.
    function test_aDripIsAThousandDollarsOrOneShare() public view {
        assertEq(dollar.DRIP(), 1000e6);
        assertEq(stock.DRIP(), 1e18);
        assertEq(dollar.COOLDOWN(), 1 days);
    }
}
