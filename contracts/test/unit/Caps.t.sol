// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {IOutcomes, Outcome, PositionVault} from "../../src/PositionVault.sol";
import {ReenteringCollateral, TestCollateral, TestOutcomes} from "./PositionVault.t.sol";
import {TestStock} from "./MarketFactory.t.sol";

/// @title CapsTest
/// @notice Each vault holds at most its cap outstanding, counted by its legs' supply: a split up to
///         the cap passes and one unit more is refused with the typed error; merging frees room;
///         leaving is never capped; a donation cannot block a split; a re-entered split is refused
///         either by the cap or by the movement check; and the caps are part of a market's identity.
contract CapsTest is Test {
    bytes32 internal constant EVENT = keccak256("an event");
    uint256 internal constant UNDERLYING_CAP = 2e18;
    uint256 internal constant DOLLAR_CAP = 1_000e6;

    address internal resolver = makeAddr("resolver");
    address internal holder = makeAddr("holder");

    MarketFactory internal factory;
    TestStock internal underlying;
    TestCollateral internal dollar;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;

    /// @notice A market capped at 2 shares and 1,000 dollars, and a holder with collateral to spare.
    function setUp() public {
        factory = new MarketFactory();
        underlying = new TestStock();
        dollar = new TestCollateral();
        (underlyingVault, dollarVault) = factory.markets(
            factory.createMarket(
                IERC20(address(underlying)),
                IERC20(address(dollar)),
                EVENT,
                resolver,
                UNDERLYING_CAP,
                DOLLAR_CAP
            )
        );
        dollar.mint(holder, 10 * DOLLAR_CAP);
        underlying.mint(holder, 10 * UNDERLYING_CAP);
        vm.startPrank(holder);
        dollar.approve(address(dollarVault), type(uint256).max);
        underlying.approve(address(underlyingVault), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice A cap of zero, on either vault, is refused: nobody could enter such a market.
    function test_RevertWhen_aCapIsZero() public {
        vm.expectRevert(MarketFactory.ZeroCap.selector);
        factory.createMarket(
            IERC20(address(underlying)), IERC20(address(dollar)), EVENT, resolver, 0, 1
        );
        vm.expectRevert(MarketFactory.ZeroCap.selector);
        factory.createMarket(
            IERC20(address(underlying)), IERC20(address(dollar)), EVENT, resolver, 1, 0
        );
    }

    /// @notice Each vault records its own cap.
    function test_eachVaultRecordsItsCap() public view {
        assertEq(underlyingVault.CAP(), UNDERLYING_CAP);
        assertEq(dollarVault.CAP(), DOLLAR_CAP);
    }

    /// @notice A split that reaches the cap exactly passes; one unit more is refused, saying the cap,
    ///         what is outstanding and what was asked; and the underlying's cap is its own.
    function test_RevertWhen_aSplitPassesTheCap() public {
        vm.startPrank(holder);
        dollarVault.splitPosition(DOLLAR_CAP - 1);
        dollarVault.splitPosition(1);
        vm.expectRevert(
            abi.encodeWithSelector(PositionVault.CapExceeded.selector, DOLLAR_CAP, DOLLAR_CAP, 1)
        );
        dollarVault.splitPosition(1);
        underlyingVault.splitPosition(UNDERLYING_CAP);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.CapExceeded.selector, UNDERLYING_CAP, UNDERLYING_CAP, 1
            )
        );
        underlyingVault.splitPosition(1);
        vm.stopPrank();
    }

    /// @notice Near the largest cap a split that would carry the count past the largest number is
    ///         refused with the typed error rather than an arithmetic panic. Only a collateral whose
    ///         administrator can take the vault's balance from it gets there — the movement check
    ///         stops any honest one first — and one is modelled here.
    function test_RevertWhen_aSplitWouldOverflowTheCount() public {
        PhantomCollateral phantom = new PhantomCollateral();
        PositionVault vault = new PositionVault(
            IERC20(address(phantom)),
            keccak256("a market"),
            IOutcomes(address(new TestOutcomes())),
            keccak256("a condition"),
            type(uint256).max
        );
        vm.startPrank(holder);
        vault.splitPosition(type(uint256).max - 10);
        vm.stopPrank();
        phantom.seize(address(vault));
        vm.startPrank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.CapExceeded.selector, type(uint256).max, type(uint256).max - 10, 11
            )
        );
        vault.splitPosition(11);
        vm.stopPrank();
    }

    /// @notice Merging frees room: what was merged can be split again.
    function test_mergingFreesRoom() public {
        vm.startPrank(holder);
        dollarVault.splitPosition(DOLLAR_CAP);
        dollarVault.mergePositions(400e6);
        dollarVault.splitPosition(400e6);
        vm.stopPrank();
        assertEq(dollarVault.YES().totalSupply(), DOLLAR_CAP);
    }

    /// @notice Leaving is never capped: a full vault merges and, once resolved, redeems.
    function test_leavingIsNeverCapped() public {
        vm.startPrank(holder);
        dollarVault.splitPosition(DOLLAR_CAP);
        dollarVault.mergePositions(100e6);
        vm.stopPrank();
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);
        vm.prank(holder);
        dollarVault.redeemPositions(DOLLAR_CAP - 100e6, DOLLAR_CAP - 100e6);
        assertEq(dollar.balanceOf(holder), 10 * DOLLAR_CAP);
    }

    /// @notice A donation of collateral to the vault blocks nothing: the cap counts legs, not the
    ///         balance anyone can raise.
    function test_aDonationDoesNotBlockASplit() public {
        dollar.mint(address(dollarVault), 10 * DOLLAR_CAP);
        vm.prank(holder);
        dollarVault.splitPosition(DOLLAR_CAP);
        assertEq(dollarVault.YES().totalSupply(), DOLLAR_CAP);
    }

    /// @notice A split re-entered from the collateral's pull that would pass the cap is refused by
    ///         the cap, its own error carried out of the outer call.
    function test_RevertWhen_aReenteredSplitWouldPassTheCap() public {
        (ReenteringCollateral token, PositionVault vault) = _reentrantVault(100e6);
        token.arm(vault, 80e6, 0);
        vm.expectRevert(
            abi.encodeWithSelector(PositionVault.CapExceeded.selector, 100e6, 50e6, 80e6)
        );
        vm.prank(holder);
        vault.splitPosition(1e6);
    }

    /// @notice A split re-entered from the pull that fills the cap leaves the outer split refused by
    ///         the movement check: the vault saw more collateral arrive than the outer split asked.
    function test_RevertWhen_aReenteredSplitFillsTheCap() public {
        (ReenteringCollateral token, PositionVault vault) = _reentrantVault(100e6);
        token.arm(vault, 50e6, 0);
        vm.expectRevert(
            abi.encodeWithSelector(PositionVault.CollateralMismatch.selector, 1e6, 51e6)
        );
        vm.prank(holder);
        vault.splitPosition(1e6);
    }

    /// @notice Two markets that differ only by their caps are two markets, with their own vaults.
    function test_twoCapsAreTwoMarkets() public {
        bytes32 first = factory.createMarket(
            IERC20(address(underlying)), IERC20(address(dollar)), EVENT, resolver, 1, 2
        );
        bytes32 second = factory.createMarket(
            IERC20(address(underlying)), IERC20(address(dollar)), EVENT, resolver, 2, 1
        );
        assertNotEq(first, second);
        (, PositionVault firstDollar) = factory.markets(first);
        (, PositionVault secondDollar) = factory.markets(second);
        assertNotEq(address(firstDollar), address(secondDollar));
        assertEq(firstDollar.CAP(), 2);
        assertEq(secondDollar.CAP(), 1);
    }

    /// @notice A vault over a collateral that calls back into it, capped, already holding half its cap
    ///         split by the collateral itself, which also pays for the re-entered split.
    /// @param cap The cap.
    /// @return token The collateral.
    /// @return vault The vault.
    function _reentrantVault(uint256 cap)
        internal
        returns (ReenteringCollateral token, PositionVault vault)
    {
        token = new ReenteringCollateral();
        vault = new PositionVault(
            IERC20(address(token)),
            keccak256("a market"),
            IOutcomes(address(new TestOutcomes())),
            keccak256("a condition"),
            cap
        );
        // Enough for its own half and for any split it re-enters.
        token.mint(address(token), 2 * cap);
        vm.startPrank(address(token));
        token.approve(address(vault), type(uint256).max);
        vault.splitPosition(cap / 2);
        vm.stopPrank();
        token.mint(holder, cap);
        vm.prank(holder);
        token.approve(address(vault), type(uint256).max);
    }
}

/// @notice A collateral that reports every transfer as made and credits the recipient without
///         debiting anyone, and whose administrator can take any balance, so a vault can be driven
///         to any count with less collateral than legs. For tests only.
contract PhantomCollateral {
    mapping(address account => uint256 balance) internal held;

    /// @notice Six decimals, like a dollar.
    /// @return The decimals.
    function decimals() external pure returns (uint8) {
        return 6;
    }

    /// @notice A symbol, as every collateral reports one.
    /// @return The symbol.
    function symbol() external pure returns (string memory) {
        return "PHANTOM";
    }

    /// @notice Credits the recipient and reports success, whatever the sender holds.
    /// @param to The recipient.
    /// @param value How much.
    /// @return Always true.
    function transferFrom(address, address to, uint256 value) external returns (bool) {
        unchecked {
            held[to] += value;
        }
        return true;
    }

    /// @notice Takes an account's whole balance, as an administrator of a token may.
    /// @param account The account.
    function seize(address account) external {
        held[account] = 0;
    }

    /// @notice What an account has been credited.
    /// @param account The account.
    /// @return The balance.
    function balanceOf(address account) external view returns (uint256) {
        return held[account];
    }
}
