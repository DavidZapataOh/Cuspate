// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {Outcome} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {SkimmingDollar} from "./OptimisticResolver.t.sol";

/// @title DisputesTest
/// @notice A first dispute discards the proposal and reopens the event; a second sends it to the
///         arbiter, whose ruling is reported. Every contest's bonds go to whoever was right, less a
///         fixed burn that never leaves the resolver.
contract DisputesTest is Test {
    uint256 internal constant BOND = 500e6;
    uint256 internal constant BURN = 100e6;
    uint256 internal constant LIVENESS = 2 hours;

    address internal sealer = makeAddr("sealer");
    address internal arbiter = makeAddr("arbiter");
    address internal proposer = makeAddr("proposer");
    address internal disputer = makeAddr("disputer");
    address internal second = makeAddr("second proposer");
    address internal stranger = makeAddr("stranger");

    ThresholdRegistry internal registry;
    MarketFactory internal factory;
    SkimmingDollar internal dollar;
    OptimisticResolver internal resolver;
    ThresholdRegistry.Threshold internal threshold;
    bytes32 internal eventId;

    /// @notice A sealed event with threshold 1.23 and funded participants.
    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new ThresholdRegistry();
        factory = new MarketFactory();
        dollar = new SkimmingDollar();
        resolver = new OptimisticResolver(
            factory, registry, sealer, arbiter, IERC20(address(dollar)), BOND, BURN, LIVENESS
        );
        threshold = ThresholdRegistry.Threshold({
            value: 123,
            decimals: 2,
            announcesAt: uint64(vm.getBlockTimestamp() + 1 days),
            deadline: uint64(vm.getBlockTimestamp() + 9 days),
            terms: "earnings per share, diluted, as first published"
        });
        vm.prank(sealer);
        eventId = registry.seal(threshold);
        address[3] memory funded = [proposer, disputer, second];
        for (uint256 i = 0; i < 3; i++) {
            dollar.mint(funded[i], 10 * BOND);
            vm.prank(funded[i]);
            dollar.approve(address(resolver), type(uint256).max);
        }
        vm.warp(threshold.announcesAt);
    }

    /// @notice The constructor refuses a zero arbiter, a zero burn, and a burn above the bond.
    function test_RevertWhen_theArbiterOrTheBurnIsInvalid() public {
        IERC20 token = IERC20(address(dollar));
        // The burn's refusal first: measured, the coverage tool drops the hits of a test's last
        // expected-revert creation, and this branch would read as never taken.
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.BurnAboveBond.selector, BOND + 1, BOND)
        );
        new OptimisticResolver(factory, registry, sealer, arbiter, token, BOND, BOND + 1, LIVENESS);
        vm.expectRevert(OptimisticResolver.ZeroParameter.selector);
        new OptimisticResolver(factory, registry, sealer, address(0), token, BOND, BURN, LIVENESS);
        vm.expectRevert(OptimisticResolver.ZeroParameter.selector);
        new OptimisticResolver(factory, registry, sealer, arbiter, token, BOND, 0, LIVENESS);
    }

    /// @notice A dispute in the window posts the bond, discards round 0 and opens round 1.
    function test_aFirstDisputeResetsTheEvent() public {
        _propose(proposer, 125);
        vm.expectEmit(address(resolver));
        emit OptimisticResolver.Disputed(eventId, 0, disputer);
        vm.prank(disputer);
        resolver.dispute(eventId);

        OptimisticResolver.EventState memory state = resolver.eventOf(eventId);
        assertEq(state.round, 1);
        assertFalse(state.pendingArbitration);
        assertEq(state.rounds[0].disputer, disputer);
        assertEq(dollar.balanceOf(address(resolver)), 2 * BOND);

        _propose(second, 120);
        assertEq(resolver.proposalOf(eventId).proposer, second);
    }

    /// @notice The window's last second accepts a dispute; its close refuses it.
    function test_aDisputeIsAcceptedUntilTheWindowCloses() public {
        _propose(proposer, 125);
        uint256 closesAt = vm.getBlockTimestamp() + LIVENESS;
        vm.warp(closesAt);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.WindowClosed.selector, closesAt));
        vm.prank(disputer);
        resolver.dispute(eventId);
        vm.warp(closesAt - 1);
        vm.prank(disputer);
        resolver.dispute(eventId);
    }

    /// @notice Nothing to dispute: no proposal, or one already settled.
    function test_RevertWhen_thereIsNothingToDispute() public {
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NoProposal.selector, eventId));
        vm.prank(disputer);
        resolver.dispute(eventId);

        _propose(proposer, 125);
        vm.warp(vm.getBlockTimestamp() + LIVENESS);
        resolver.settle(eventId);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.AlreadySettled.selector, eventId));
        vm.prank(disputer);
        resolver.dispute(eventId);
    }

    /// @notice A disputer short of the bond disputes nothing.
    function test_RevertWhen_theDisputerIsUnderfunded() public {
        _propose(proposer, 125);
        vm.prank(stranger);
        vm.expectRevert();
        resolver.dispute(eventId);
        assertEq(resolver.eventOf(eventId).round, 0);
    }

    /// @notice A second dispute leaves the event pending: nothing settles, nothing is proposed, and
    ///         nothing is disputed until the arbiter rules.
    function test_aSecondDisputeLeavesTheEventPendingArbitration() public {
        _escalate(120);
        assertTrue(resolver.eventOf(eventId).pendingArbitration);
        vm.warp(vm.getBlockTimestamp() + LIVENESS);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.PendingArbitration.selector, eventId)
        );
        resolver.settle(eventId);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.PendingArbitration.selector, eventId)
        );
        vm.prank(stranger);
        resolver.proposeFigure(eventId, 130, 2);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.PendingArbitration.selector, eventId)
        );
        vm.prank(disputer);
        resolver.dispute(eventId);
    }

    /// @notice A successful challenge reverses the outcome and transfers the loser's bond: round 1
    ///         proposed a figure below the threshold, the arbiter rules one above it, the yes outcome
    ///         is reported, and the disputer is credited both bonds less the burn.
    function test_aSuccessfulChallengeReversesTheOutcomeAndTransfersTheLosersBond() public {
        _escalate(120);
        vm.expectEmit(address(resolver));
        emit OptimisticResolver.ContestRuled(eventId, 1, disputer, 2 * BOND - BURN, BURN);
        vm.expectEmit(address(resolver));
        emit OptimisticResolver.OutcomeRuled(eventId, Outcome.Yes);
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 125, 2, false);

        assertEq(
            uint8(factory.outcomeOf(factory.condition(address(resolver), eventId))),
            uint8(Outcome.Yes)
        );
        assertEq(resolver.owed(disputer), 2 * BOND - BURN);
        assertEq(resolver.owed(second), 0);
        assertEq(resolver.burned(), BURN);
        assertFalse(resolver.eventOf(eventId).pendingArbitration);
    }

    /// @notice A ruling that confirms round 1 credits its proposer instead.
    function test_aRulingThatConfirmsRoundOneCreditsItsProposer() public {
        _escalate(120);
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 1200, 3, true);
        assertEq(
            uint8(factory.outcomeOf(factory.condition(address(resolver), eventId))),
            uint8(Outcome.No)
        );
        assertEq(resolver.owed(second), 2 * BOND - BURN);
        assertEq(resolver.owed(disputer), 0);
    }

    /// @notice The proposer is ruled right only if the ruled figure is the proposed one, by value.
    function test_RevertWhen_theProposerIsRuledRightForAnotherFigure() public {
        _escalate(120);
        vm.expectRevert(OptimisticResolver.NotTheRuledAnswer.selector);
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 121, 2, true);
    }

    /// @notice A ruled figure carries at most eighteen decimals.
    function test_RevertWhen_aRuledFigureHasMoreThanEighteenDecimals() public {
        _escalate(120);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.DecimalsTooLarge.selector, uint8(19))
        );
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 125, 19, false);
    }

    /// @notice Invalid is ruled only after the deadline, and its proposer was right only if it
    ///         proposed invalid.
    function test_invalidIsRuledOnlyAfterTheDeadline() public {
        _escalate(120);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.BeforeDeadline.selector, threshold.deadline)
        );
        vm.prank(arbiter);
        resolver.ruleInvalid(eventId, false);
        vm.warp(uint256(threshold.deadline) + 1);
        vm.expectRevert(OptimisticResolver.NotTheRuledAnswer.selector);
        vm.prank(arbiter);
        resolver.ruleInvalid(eventId, true);
        vm.prank(arbiter);
        resolver.ruleInvalid(eventId, false);
        assertEq(
            uint8(factory.outcomeOf(factory.condition(address(resolver), eventId))),
            uint8(Outcome.Invalid)
        );
    }

    /// @notice An outcome is ruled once, and only for an event pending arbitration.
    function test_RevertWhen_rulingAnEventNotPending() public {
        _propose(proposer, 125);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotPending.selector, eventId));
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 125, 2, true);

        vm.prank(disputer);
        resolver.dispute(eventId);
        _propose(second, 120);
        vm.prank(disputer);
        resolver.dispute(eventId);
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 125, 2, false);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotPending.selector, eventId));
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 125, 2, false);
    }

    /// @notice Round 0's contest is ruled once, after its dispute, crediting whoever was right.
    function test_theRoundZeroContestIsRuledOnce() public {
        _propose(proposer, 125);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotDisputed.selector, eventId));
        vm.prank(arbiter);
        resolver.ruleContest(eventId, true);

        vm.prank(disputer);
        resolver.dispute(eventId);
        vm.prank(arbiter);
        resolver.ruleContest(eventId, true);
        assertEq(resolver.owed(proposer), 2 * BOND - BURN);
        assertEq(resolver.burned(), BURN);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.AlreadyRuled.selector, eventId));
        vm.prank(arbiter);
        resolver.ruleContest(eventId, false);
    }

    /// @notice Every bond is accounted for once both contests are ruled and the winners withdraw:
    ///         what is left in the resolver is exactly what was burned.
    function test_everyBondIsAccountedFor() public {
        _escalate(120);
        vm.prank(arbiter);
        resolver.ruleContest(eventId, false);
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 125, 2, false);
        vm.prank(disputer);
        resolver.withdraw();
        assertEq(dollar.balanceOf(address(resolver)), resolver.burned());
        assertEq(resolver.burned(), 2 * BURN);
        assertEq(dollar.balanceOf(disputer), 10 * BOND - 2 * BOND + 2 * (2 * BOND - BURN));
    }

    /// @notice A ruling reports the outcome even while the bond token refuses every transfer.
    function test_aRulingDoesNotWaitOnTheBondToken() public {
        _escalate(120);
        dollar.stop();
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 125, 2, false);
        assertEq(
            uint8(factory.outcomeOf(factory.condition(address(resolver), eventId))),
            uint8(Outcome.Yes)
        );
    }

    /// @notice Only the arbiter rules a figure.
    function test_RevertWhen_ruleFigureCallerIsNotTheArbiter() public {
        _escalate(120);
        vm.expectRevert(OptimisticResolver.NotArbiter.selector);
        vm.prank(stranger);
        resolver.ruleFigure(eventId, 125, 2, false);
    }

    /// @notice Only the arbiter rules invalid.
    function test_RevertWhen_ruleInvalidCallerIsNotTheArbiter() public {
        _escalate(120);
        vm.warp(uint256(threshold.deadline) + 1);
        vm.expectRevert(OptimisticResolver.NotArbiter.selector);
        vm.prank(stranger);
        resolver.ruleInvalid(eventId, false);
    }

    /// @notice Only the arbiter rules a contest.
    function test_RevertWhen_ruleContestCallerIsNotTheArbiter() public {
        _propose(proposer, 125);
        vm.prank(disputer);
        resolver.dispute(eventId);
        vm.expectRevert(OptimisticResolver.NotArbiter.selector);
        vm.prank(stranger);
        resolver.ruleContest(eventId, true);
    }

    /// @notice A round-1 proposal nobody disputes settles as any proposal does.
    function test_anUndisputedRoundOneSettles() public {
        _propose(proposer, 125);
        vm.prank(disputer);
        resolver.dispute(eventId);
        _propose(second, 120);
        vm.warp(vm.getBlockTimestamp() + LIVENESS);
        resolver.settle(eventId);
        assertEq(
            uint8(factory.outcomeOf(factory.condition(address(resolver), eventId))),
            uint8(Outcome.No)
        );
        assertEq(resolver.owed(second), BOND);
    }

    /// @notice Proposes a figure, scaled by a hundred.
    /// @param who The proposer.
    /// @param figure The figure.
    function _propose(address who, int256 figure) internal {
        vm.prank(who);
        resolver.proposeFigure(eventId, figure, 2);
    }

    /// @notice Round 0 proposed and disputed, round 1 proposed at a figure and disputed.
    /// @param roundOneFigure Round 1's figure.
    function _escalate(int256 roundOneFigure) internal {
        _propose(proposer, 125);
        vm.prank(disputer);
        resolver.dispute(eventId);
        _propose(second, roundOneFigure);
        vm.prank(disputer);
        resolver.dispute(eventId);
    }
}
