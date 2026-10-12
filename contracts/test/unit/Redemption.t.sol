// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";
import {TestCollateral} from "./PositionVault.t.sol";
import {TestStock} from "./MarketFactory.t.sol";

/// @title ReportingCollateral
/// @notice A collateral that, in the middle of a transfer, makes a resolver report: as a collateral
///         with transfer hooks calling a resolver anyone can settle would. For tests only.
contract ReportingCollateral is TestCollateral {
    MarketFactory internal factory;
    bytes32 internal eventId;

    /// @notice Arms the report for the next transfer, made by this token as the resolver.
    /// @param target The factory to report to.
    /// @param event_ The event to report.
    function arm(MarketFactory target, bytes32 event_) external {
        factory = target;
        eventId = event_;
    }

    /// @notice Reports a yes once, before the transfer it is part of.
    /// @param from The sender.
    /// @param to The recipient.
    /// @param value How much.
    function _update(address from, address to, uint256 value) internal override {
        MarketFactory target = factory;
        if (address(target) != address(0) && from != address(0) && to != address(0)) {
            factory = MarketFactory(address(0));
            target.reportOutcome(eventId, Outcome.Yes);
        }
        super._update(from, to, value);
    }
}

/// @title RedemptionTest
/// @notice Reporting an outcome once per condition, and redeeming legs against it.
contract RedemptionTest is Test {
    bytes32 internal constant EVENT = keccak256("an event");
    uint256 internal constant AMOUNT = 101e6;

    address internal resolver = makeAddr("resolver");
    address internal other = makeAddr("another resolver");
    address internal holder = makeAddr("holder");
    address internal buyer = makeAddr("buyer");

    MarketFactory internal factory;
    IERC20 internal underlying;
    TestCollateral internal dollar;
    PositionVault internal vault;

    /// @notice A market whose dollar vault the holder has split into.
    function setUp() public {
        factory = new MarketFactory();
        underlying = IERC20(address(new TestStock()));
        dollar = new TestCollateral();
        bytes32 id = factory.createMarket(underlying, IERC20(address(dollar)), EVENT, resolver);
        (, vault) = factory.markets(id);
        dollar.mint(holder, AMOUNT);
        vm.startPrank(holder);
        dollar.approve(address(vault), AMOUNT);
        vault.splitPosition(AMOUNT);
        vm.stopPrank();
    }

    /// @notice A condition is a hash of its resolver and its event, and a market's id a hash of its
    ///         collaterals and its condition.
    function test_conditionAndMarketIdAreTheStatedHashes() public view {
        bytes32 condition = keccak256(abi.encode(resolver, EVENT));
        assertEq(factory.condition(resolver, EVENT), condition);
        assertEq(
            factory.marketId(underlying, IERC20(address(dollar)), condition),
            keccak256(abi.encode(underlying, IERC20(address(dollar)), condition))
        );
        assertEq(vault.CONDITION(), condition);
    }

    /// @notice A report lands under its sender's condition and under no one else's.
    function test_reportLandsUnderTheSendersConditionOnly() public {
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);
        assertEq(uint8(factory.outcomeOf(factory.condition(resolver, EVENT))), uint8(Outcome.Yes));
        assertEq(
            uint8(factory.outcomeOf(factory.condition(other, EVENT))), uint8(Outcome.Unresolved)
        );
    }

    /// @notice A report is announced with its condition, its sender, its event and the outcome.
    function test_reportEmitsOutcomeReported() public {
        vm.expectEmit(address(factory));
        emit MarketFactory.OutcomeReported(
            factory.condition(resolver, EVENT), resolver, EVENT, Outcome.Invalid
        );
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Invalid);
    }

    /// @notice A condition's outcome is written once.
    function test_RevertWhen_outcomeIsReportedTwice() public {
        vm.startPrank(resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);
        vm.expectRevert(
            abi.encodeWithSelector(
                MarketFactory.OutcomeAlreadyReported.selector, factory.condition(resolver, EVENT)
            )
        );
        factory.reportOutcome(EVENT, Outcome.No);
        vm.stopPrank();
    }

    /// @notice Unresolved is not an outcome anyone can report.
    function test_RevertWhen_reportedOutcomeIsNotFinal() public {
        vm.expectRevert(MarketFactory.OutcomeNotFinal.selector);
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Unresolved);
    }

    /// @notice Every market over one condition reads its one outcome.
    function test_marketsOverOneConditionReadOneOutcome() public {
        TestCollateral otherDollar = new TestCollateral();
        bytes32 second =
            factory.createMarket(underlying, IERC20(address(otherDollar)), EVENT, resolver);
        (, PositionVault secondVault) = factory.markets(second);
        assertEq(secondVault.CONDITION(), vault.CONDITION());
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.No);
        assertEq(uint8(factory.outcomeOf(secondVault.CONDITION())), uint8(Outcome.No));
    }

    /// @notice The same event with another resolver is another market, untouched by this one's report.
    function test_aDifferentResolverIsADifferentMarket() public {
        bytes32 mine = factory.marketId(
            underlying, IERC20(address(dollar)), factory.condition(resolver, EVENT)
        );
        bytes32 theirs = factory.createMarket(underlying, IERC20(address(dollar)), EVENT, other);
        assertTrue(mine != theirs);
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);
        (, PositionVault theirVault) = factory.markets(theirs);
        assertEq(uint8(factory.outcomeOf(theirVault.CONDITION())), uint8(Outcome.Unresolved));
    }

    /// @notice A yes pays the yes leg in full and the no leg nothing.
    function test_aYesPaysTheYesLegInFull() public {
        _report(Outcome.Yes);
        _redeem(holder, AMOUNT, AMOUNT);
        assertEq(dollar.balanceOf(holder), AMOUNT);
    }

    /// @notice A no pays the no leg in full and the yes leg nothing.
    function test_aNoPaysTheNoLegInFull() public {
        _report(Outcome.No);
        _redeem(holder, AMOUNT, 0);
        assertEq(dollar.balanceOf(holder), 0);
        _redeem(holder, 0, AMOUNT);
        assertEq(dollar.balanceOf(holder), AMOUNT);
    }

    /// @notice An invalid outcome pays each leg half, rounding down once over the sum: an odd total
    ///         loses half a unit, and the remainder stays in the vault.
    function test_anInvalidOutcomePaysHalfEachRoundingDownOnce() public {
        IERC20 no = vault.NO();
        vm.prank(holder);
        assertTrue(no.transfer(buyer, AMOUNT));
        _report(Outcome.Invalid);
        _redeem(holder, AMOUNT, 0);
        _redeem(buyer, 0, AMOUNT);
        assertEq(dollar.balanceOf(holder), AMOUNT / 2);
        assertEq(dollar.balanceOf(buyer), AMOUNT / 2);
        assertEq(dollar.balanceOf(address(vault)), AMOUNT % 2);
    }

    /// @notice Redeeming burns exactly the legs redeemed.
    function test_redeemingBurnsTheLegsRedeemed() public {
        _report(Outcome.Yes);
        _redeem(holder, AMOUNT / 4, AMOUNT / 5);
        assertEq(vault.YES().balanceOf(holder), AMOUNT - AMOUNT / 4);
        assertEq(vault.NO().balanceOf(holder), AMOUNT - AMOUNT / 5);
    }

    /// @notice A redemption is announced first, with what was redeemed.
    function test_redeemingEmitsPayoutRedemption() public {
        _report(Outcome.Yes);
        vm.expectEmit(address(vault));
        emit PositionVault.PayoutRedemption(holder, AMOUNT, 0);
        _redeem(holder, AMOUNT, 0);
    }

    /// @notice Nothing redeems before an outcome is reported.
    function test_RevertWhen_redeemingBeforeResolution() public {
        vm.expectRevert(PositionVault.MarketNotResolved.selector);
        _redeem(holder, AMOUNT, AMOUNT);
    }

    /// @notice Nothing splits after an outcome is reported.
    function test_RevertWhen_splittingAfterResolution() public {
        _report(Outcome.Yes);
        dollar.mint(holder, AMOUNT);
        vm.startPrank(holder);
        dollar.approve(address(vault), AMOUNT);
        vm.expectRevert(PositionVault.MarketResolved.selector);
        vault.splitPosition(AMOUNT);
        vm.stopPrank();
    }

    /// @notice Merging stays open after resolution and returns the full collateral.
    function test_mergingStaysOpenAfterResolution() public {
        _report(Outcome.No);
        vm.prank(holder);
        vault.mergePositions(AMOUNT);
        assertEq(dollar.balanceOf(holder), AMOUNT);
    }

    /// @notice An outcome reported while a split is pulling its collateral still stops the split:
    ///         the check comes after the collateral has arrived, before anything is minted.
    function test_RevertWhen_outcomeIsReportedDuringTheSplitsPull() public {
        ReportingCollateral hooked = new ReportingCollateral();
        bytes32 id =
            factory.createMarket(underlying, IERC20(address(hooked)), EVENT, address(hooked));
        (, PositionVault hookedVault) = factory.markets(id);
        hooked.mint(holder, AMOUNT);
        hooked.arm(factory, EVENT);
        vm.startPrank(holder);
        hooked.approve(address(hookedVault), AMOUNT);
        vm.expectRevert(PositionVault.MarketResolved.selector);
        hookedVault.splitPosition(AMOUNT);
        vm.stopPrank();
    }

    /// @notice A market nobody can resolve is refused.
    function test_RevertWhen_resolverIsZero() public {
        vm.expectRevert(MarketFactory.ZeroResolver.selector);
        factory.createMarket(underlying, IERC20(address(dollar)), keccak256("other"), address(0));
    }

    /// @notice Reports an outcome for this market's condition.
    /// @param outcome The outcome.
    function _report(Outcome outcome) private {
        vm.prank(resolver);
        factory.reportOutcome(EVENT, outcome);
    }

    /// @notice Redeems legs as a holder.
    /// @param account The holder.
    /// @param yesAmount How much of the yes leg.
    /// @param noAmount How much of the no leg.
    function _redeem(address account, uint256 yesAmount, uint256 noAmount) private {
        vm.prank(account);
        vault.redeemPositions(yesAmount, noAmount);
    }
}
