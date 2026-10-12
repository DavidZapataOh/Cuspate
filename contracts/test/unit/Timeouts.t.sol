// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {TestCollateral} from "./PositionVault.t.sol";
import {TestStock} from "./MarketFactory.t.sol";

/// @title TimeoutsTest
/// @notice Every way an event can stall has an exit anyone can take: an event nobody resolves expires
///         invalid after its deadline and a grace period; an event the arbiter never rules expires
///         invalid with both bonds returned; a first contest the arbiter never rules is released.
contract TimeoutsTest is Test {
    uint256 internal constant BOND = 500e6;
    uint256 internal constant BURN = 100e6;
    uint256 internal constant LIVENESS = 2 hours;
    uint256 internal constant EXPIRY = 7 days;
    uint256 internal constant ARBITER_TIMEOUT = 7 days;

    address internal sealer = makeAddr("sealer");
    address internal arbiter = makeAddr("arbiter");
    address internal proposer = makeAddr("proposer");
    address internal disputer = makeAddr("disputer");
    address internal second = makeAddr("second proposer");
    address internal anyone = makeAddr("anyone");

    ThresholdRegistry internal registry;
    MarketFactory internal factory;
    TestCollateral internal dollar;
    OptimisticResolver internal resolver;
    ThresholdRegistry.Threshold internal threshold;
    bytes32 internal eventId;

    /// @notice A sealed event, at its announcement, with funded participants.
    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new ThresholdRegistry();
        factory = new MarketFactory();
        dollar = new TestCollateral();
        resolver = new OptimisticResolver(
            factory,
            registry,
            sealer,
            arbiter,
            IERC20(address(dollar)),
            BOND,
            BURN,
            LIVENESS,
            EXPIRY,
            ARBITER_TIMEOUT
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

    /// @notice The constructor refuses a zero expiry or timeout, and one that could overflow a clock.
    function test_RevertWhen_theTimeoutsAreInvalid() public {
        IERC20 token = IERC20(address(dollar));
        // The overflow refusal first: measured, the coverage tool drops the hits of a test's last
        // expected-revert creation, and this branch would read as never taken.
        uint256 tooLong = uint256(type(uint64).max) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.DurationTooLong.selector, tooLong)
        );
        new OptimisticResolver(
            factory,
            registry,
            sealer,
            arbiter,
            token,
            BOND,
            BURN,
            LIVENESS,
            tooLong,
            ARBITER_TIMEOUT
        );
        vm.expectRevert(OptimisticResolver.ZeroParameter.selector);
        new OptimisticResolver(
            factory, registry, sealer, arbiter, token, BOND, BURN, LIVENESS, 0, ARBITER_TIMEOUT
        );
        vm.expectRevert(OptimisticResolver.ZeroParameter.selector);
        new OptimisticResolver(
            factory, registry, sealer, arbiter, token, BOND, BURN, LIVENESS, EXPIRY, 0
        );
    }

    /// @notice An event nobody proposes expires invalid one second after its deadline plus the
    ///         expiry, not at it; a market over it then redeems half and half.
    function test_anEventNobodyResolvesExpiresInvalid() public {
        bytes32 id = factory.createMarket(
            IERC20(address(new TestStock())), IERC20(address(dollar)), eventId, address(resolver)
        );
        (, PositionVault vault) = factory.markets(id);
        dollar.mint(anyone, 100e6);
        vm.startPrank(anyone);
        dollar.approve(address(vault), 100e6);
        vault.splitPosition(100e6);
        vm.stopPrank();

        uint256 expiresAt = uint256(threshold.deadline) + EXPIRY;
        assertEq(resolver.expiresAt(eventId), expiresAt);
        vm.warp(expiresAt);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotExpired.selector, expiresAt));
        vm.prank(anyone);
        resolver.expire(eventId);

        vm.warp(expiresAt + 1);
        vm.expectEmit(address(resolver));
        emit OptimisticResolver.Expired(eventId, false);
        vm.prank(anyone);
        resolver.expire(eventId);
        assertEq(uint8(_outcome()), uint8(Outcome.Invalid));

        vm.prank(anyone);
        vault.redeemPositions(100e6, 100e6);
        assertEq(dollar.balanceOf(anyone), 100e6);
    }

    /// @notice A proposal is accepted up to the expiry instant and refused after it, so no bond can
    ///         land on an event that can no longer settle.
    function test_noProposalIsAcceptedAfterExpiry() public {
        uint256 expiresAt = resolver.expiresAt(eventId);
        vm.warp(expiresAt + 1);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.EventExpired.selector, expiresAt));
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.EventExpired.selector, expiresAt));
        vm.prank(proposer);
        resolver.proposeInvalid(eventId);

        vm.warp(expiresAt);
        vm.prank(proposer);
        resolver.proposeInvalid(eventId);
    }

    /// @notice A live proposal is never pre-empted: the event does not expire while it waits, and
    ///         once its window closes the exit is settlement.
    function test_RevertWhen_expiringAnEventWithAProposal() public {
        vm.warp(uint256(threshold.deadline) + EXPIRY);
        vm.prank(proposer);
        resolver.proposeInvalid(eventId);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.ProposalOpen.selector, eventId));
        resolver.expire(eventId);
        vm.warp(vm.getBlockTimestamp() + LIVENESS);
        resolver.settle(eventId);
        assertEq(uint8(_outcome()), uint8(Outcome.Invalid));
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.AlreadySettled.selector, eventId));
        resolver.expire(eventId);
    }

    /// @notice A first dispute restarts the expiry clock from the disputed window's close, so a late
    ///         dispute cannot force an expiry before anyone can propose again.
    function test_aResetRestartsTheExpiryClock() public {
        vm.warp(uint256(threshold.deadline) + EXPIRY - 1);
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
        uint256 proposedAt = vm.getBlockTimestamp();
        vm.prank(disputer);
        resolver.dispute(eventId, 0);

        uint256 expiresAt = proposedAt + LIVENESS + EXPIRY;
        assertEq(resolver.expiresAt(eventId), expiresAt);
        vm.warp(proposedAt + 2);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotExpired.selector, expiresAt));
        resolver.expire(eventId);
        vm.prank(second);
        resolver.proposeFigure(eventId, 125, 2);
    }

    /// @notice An unsealed event never expires, by the same rule that never resolves it.
    function test_RevertWhen_expiringAnUnsealedEvent() public {
        bytes32 unsealed = keccak256("never sealed");
        vm.warp(uint256(threshold.deadline) + EXPIRY + 1);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotSealed.selector, unsealed));
        resolver.expire(unsealed);
    }

    /// @notice A deadlock the arbiter never rules expires invalid once its timeout passes — never
    ///         before the deadline — and both posters get their bonds back, nothing burned; at that
    ///         instant the arbiter can no longer rule.
    function test_theArbitersSilenceEndsInvalidWithBondsReturned() public {
        _escalate();
        uint256 timeout = resolver.outcomeTimeout(eventId);
        assertEq(timeout, uint256(threshold.deadline) + ARBITER_TIMEOUT);

        vm.warp(timeout - 1);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotExpired.selector, timeout));
        resolver.expire(eventId);

        vm.warp(timeout);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.TimedOut.selector, timeout));
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 125, 2, false, "too late");

        vm.expectEmit(address(resolver));
        emit OptimisticResolver.Expired(eventId, true);
        vm.prank(anyone);
        resolver.expire(eventId);
        assertEq(uint8(_outcome()), uint8(Outcome.Invalid));
        assertEq(resolver.owed(second), BOND);
        assertEq(resolver.owed(disputer), BOND);
        assertEq(resolver.burned(), 0);
        assertTrue(resolver.eventOf(eventId).rounds[1].ruled);
    }

    /// @notice One second before its timeout the arbiter still rules.
    function test_theArbiterRulesUntilItsTimeout() public {
        _escalate();
        vm.warp(resolver.outcomeTimeout(eventId) - 1);
        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 125, 2, false, "the source published 1.25");
        assertEq(uint8(_outcome()), uint8(Outcome.Yes));
    }

    /// @notice A first contest the arbiter never rules is released at its timeout: each poster gets
    ///         its own bond back, and the arbiter can no longer rule it.
    function test_anUnruledFirstContestIsReleased() public {
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
        vm.prank(disputer);
        resolver.dispute(eventId, 0);
        uint256 timeout = resolver.contestTimeout(eventId);
        assertEq(timeout, vm.getBlockTimestamp() + LIVENESS + ARBITER_TIMEOUT);

        vm.warp(timeout - 1);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotTimedOut.selector, timeout));
        resolver.release(eventId);

        vm.warp(timeout);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.TimedOut.selector, timeout));
        vm.prank(arbiter);
        resolver.ruleContest(eventId, true, "too late");

        vm.expectEmit(address(resolver));
        emit OptimisticResolver.ContestReleased(eventId);
        vm.prank(anyone);
        resolver.release(eventId);
        assertEq(resolver.owed(proposer), BOND);
        assertEq(resolver.owed(disputer), BOND);
        assertTrue(resolver.eventOf(eventId).rounds[0].ruled);
        assertEq(bytes(resolver.eventOf(eventId).rounds[0].reason).length, 0);

        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.AlreadyRuled.selector, eventId));
        resolver.release(eventId);
    }

    /// @notice Nothing to release before a dispute.
    function test_RevertWhen_releasingAnUndisputedContest() public {
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotDisputed.selector, eventId));
        resolver.release(eventId);
    }

    /// @notice Proposes at the announcement, disputes, proposes again and disputes again.
    function _escalate() internal {
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
        vm.prank(disputer);
        resolver.dispute(eventId, 0);
        vm.prank(second);
        resolver.proposeFigure(eventId, 120, 2);
        vm.prank(disputer);
        resolver.dispute(eventId, 1);
    }

    /// @notice The event's outcome at the factory.
    /// @return The outcome.
    function _outcome() internal view returns (Outcome) {
        return factory.outcomeOf(factory.condition(address(resolver), eventId));
    }
}
