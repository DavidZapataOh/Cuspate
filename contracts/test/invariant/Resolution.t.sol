// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {Outcome} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {TestCollateral} from "../unit/PositionVault.t.sol";

/// @title ResolutionHandler
/// @notice Drives events through every way they can resolve, one at a time: undisputed; disputed once
///         and settled after the reset; disputed twice and ruled — confirming, reversing, or invalid
///         after the deadline — with the first contest ruled before or after the outcome, for the
///         proposer or against it. Every branch is chosen by counters, never by seed bits, so every
///         run takes every path; the seed only picks values. Refused calls are attempted on purpose
///         and their exact refusal required. Acts as the sealer and as the arbiter, and records what
///         each account is owed and what each event's outcome must be.
/// @dev Declared in the campaign's test file: a handler is test infrastructure, and a file of its
///      own would make it a first-party contract the protocol's gates have to account for.
contract ResolutionHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant BOND = 500e6;
    uint256 internal constant BURN = 100e6;
    uint256 internal constant LIVENESS = 2 hours;

    /// @notice What the current event does next.
    enum Action {
        Seal,
        Propose,
        Dispute,
        ProposeAgain,
        DisputeAgain,
        Hold,
        Wait,
        Settle,
        RuleOutcome,
        RuleContest,
        Withdraw
    }

    /// @notice The registry, the factory and the resolver under test.
    ThresholdRegistry public immutable REGISTRY;
    /// @notice Where outcomes are reported.
    MarketFactory public immutable FACTORY;
    /// @notice The resolver under test.
    OptimisticResolver public immutable RESOLVER;
    /// @notice The bond token.
    TestCollateral public immutable DOLLAR;

    address[3] internal actors = [address(0x7001), address(0x7002), address(0x7003)];

    /// @notice Every event sealed, in order.
    bytes32[] public eventIds;
    /// @notice The outcome each event must end with; unresolved until it does.
    mapping(bytes32 eventId => Outcome) public expected;
    /// @notice Credits each account is owed in total, by the handler's tally.
    mapping(address account => uint256) public credited;
    /// @notice What each account has withdrawn.
    mapping(address account => uint256) public withdrawn;
    /// @notice Every bond posted, every amount withdrawn, every bond held for a live contest.
    uint256 public posted;
    /// @notice Everything withdrawn.
    uint256 public paidOut;
    /// @notice Bonds held for proposals and disputes not yet settled or ruled.
    uint256 public held;

    /// @notice How many events were sealed and driven.
    uint256 public lifecycles;
    /// @notice How many proposals settled undisputed.
    uint256 public settlements;
    /// @notice How many first disputes reset an event.
    uint256 public resets;
    /// @notice How many second disputes sent an event to the arbiter.
    uint256 public escalations;
    /// @notice How many outcomes the arbiter ruled.
    uint256 public outcomeRulings;
    /// @notice How many first contests the arbiter ruled.
    uint256 public contestRulings;
    /// @notice How many withdrawals were made.
    uint256 public withdrawals;

    /// @notice The event the handler is driving now.
    bytes32 public current;
    uint256 internal variant;
    uint256 internal position;
    uint64 internal deadline;

    /// @notice The paths, as sequences of actions.
    Action[][4] internal scripts;

    /// @notice Deploys the system with the handler as sealer and arbiter, and funds the actors.
    constructor() {
        REGISTRY = new ThresholdRegistry();
        FACTORY = new MarketFactory();
        DOLLAR = new TestCollateral();
        RESOLVER = new OptimisticResolver(
            FACTORY,
            REGISTRY,
            address(this),
            address(this),
            IERC20(address(DOLLAR)),
            BOND,
            BURN,
            LIVENESS
        );
        for (uint256 i = 0; i < 3; i++) {
            DOLLAR.mint(actors[i], 1e30);
            vm.prank(actors[i]);
            DOLLAR.approve(address(RESOLVER), type(uint256).max);
        }
        scripts[0] = [Action.Seal, Action.Propose, Action.Wait, Action.Settle, Action.Withdraw];
        scripts[1] = [
            Action.Seal,
            Action.Propose,
            Action.Dispute,
            Action.ProposeAgain,
            Action.Wait,
            Action.Settle,
            Action.RuleContest,
            Action.Withdraw
        ];
        scripts[2] = [
            Action.Seal,
            Action.Propose,
            Action.Dispute,
            Action.ProposeAgain,
            Action.DisputeAgain,
            Action.Hold,
            Action.RuleContest,
            Action.RuleOutcome,
            Action.Withdraw
        ];
        scripts[3] = [
            Action.Seal,
            Action.Propose,
            Action.Dispute,
            Action.ProposeAgain,
            Action.DisputeAgain,
            Action.Hold,
            Action.RuleOutcome,
            Action.RuleContest,
            Action.Withdraw
        ];
    }

    /// @notice How many events were sealed.
    /// @return The count.
    function eventCount() external view returns (uint256) {
        return eventIds.length;
    }

    /// @notice An actor by index.
    /// @param index Below three.
    /// @return The actor.
    function actorAt(uint256 index) external view returns (address) {
        return actors[index];
    }

    /// @notice Advances the current event by one action, starting the next path when one ends.
    /// @param seed Picks values: figures and amounts, never which branch is taken.
    function step(uint256 seed) external {
        Action[] storage script = scripts[variant % 4];
        Action action = script[position];
        if (action == Action.Seal) _seal(seed);
        else if (action == Action.Propose) _propose(actors[0], seed);
        else if (action == Action.Dispute) _dispute(true);
        else if (action == Action.ProposeAgain) _propose(actors[2], seed >> 64);
        else if (action == Action.DisputeAgain) _dispute(false);
        else if (action == Action.Hold) _hold();
        else if (action == Action.Wait) _wait();
        else if (action == Action.Settle) _settle();
        else if (action == Action.RuleOutcome) _ruleOutcome(seed);
        else if (action == Action.RuleContest) _ruleContest();
        else _withdrawAll();
        position++;
        if (position == script.length) {
            position = 0;
            variant++;
        }
    }

    /// @notice Seals a fresh event a second ahead, with a deadline a day after it.
    /// @param seed Picks the threshold.
    function _seal(uint256 seed) internal {
        uint64 announcesAt = uint64(block.timestamp + 1);
        deadline = announcesAt + 1 days;
        current = REGISTRY.seal(
            ThresholdRegistry.Threshold({
                value: int256(_bound(seed, 0, 1000)) - 500,
                decimals: 2,
                announcesAt: announcesAt,
                deadline: deadline,
                terms: abi.encodePacked("event ", eventIds.length)
            })
        );
        eventIds.push(current);
        lifecycles++;
        vm.warp(announcesAt);
    }

    /// @notice Proposes a figure, first attempting to settle before any proposal exists.
    /// @param who The proposer.
    /// @param seed Picks the figure.
    function _propose(address who, uint256 seed) internal {
        _refused(
            abi.encodeCall(OptimisticResolver.settle, (current)),
            abi.encodeWithSelector(OptimisticResolver.NoProposal.selector, current)
        );
        vm.prank(who);
        RESOLVER.proposeFigure(current, int256(_bound(seed, 0, 2000)) - 1000, 2);
        posted += BOND;
        held += BOND;
    }

    /// @notice Disputes the open proposal, first attempting to settle while its window is open.
    /// @param first Whether this is the event's first dispute.
    function _dispute(bool first) internal {
        _refused(
            abi.encodeCall(OptimisticResolver.settle, (current)),
            abi.encodeWithSelector(
                OptimisticResolver.WindowOpen.selector,
                RESOLVER.proposalOf(current).proposedAt + LIVENESS
            )
        );
        vm.prank(actors[1]);
        RESOLVER.dispute(current);
        posted += BOND;
        held += BOND;
        if (first) resets++;
        else escalations++;
    }

    /// @notice Waits out the window, then attempts a dispute, which must be refused.
    function _wait() internal {
        uint256 closesAt = RESOLVER.proposalOf(current).proposedAt + LIVENESS;
        vm.warp(closesAt);
        _refused(
            abi.encodeCall(OptimisticResolver.dispute, (current)),
            abi.encodeWithSelector(OptimisticResolver.WindowClosed.selector, closesAt)
        );
    }

    /// @notice Settles the open proposal, recording the outcome it implies and its proposer's credit.
    function _settle() internal {
        OptimisticResolver.Proposal memory proposal = RESOLVER.proposalOf(current);
        (,, int256 value, uint8 decimals,,) = REGISTRY.thresholdOf(current);
        expected[current] = RESOLVER.isGreater(proposal.figure, proposal.decimals, value, decimals)
            ? Outcome.Yes
            : Outcome.No;
        RESOLVER.settle(current);
        credited[proposal.proposer] += BOND;
        held -= BOND;
        settlements++;
    }

    /// @notice Waits out the disputed proposal's window, then attempts to settle the event, which must
    ///         be refused: after the window, only the pending check stands between a disputed
    ///         proposal and its outcome. A step of its own, so the properties are checked before the
    ///         arbiter rules.
    function _hold() internal {
        vm.warp(RESOLVER.eventOf(current).rounds[1].proposedAt + LIVENESS);
        _refused(
            abi.encodeCall(OptimisticResolver.settle, (current)),
            abi.encodeWithSelector(OptimisticResolver.PendingArbitration.selector, current)
        );
    }

    /// @notice Rules the outcome of the event waiting for arbitration. Alternates between confirming the second proposal,
    ///         reversing it, and ruling invalid after the deadline.
    /// @param seed Picks the reversing figure.
    function _ruleOutcome(uint256 seed) internal {
        OptimisticResolver.Proposal memory second = RESOLVER.eventOf(current).rounds[1];
        (,, int256 value, uint8 decimals,,) = REGISTRY.thresholdOf(current);
        uint256 kind = outcomeRulings % 3;
        bool proposerWasRight = kind == 0;
        if (kind == 2) {
            vm.warp(uint256(deadline) + 1);
            RESOLVER.ruleInvalid(current, false);
            expected[current] = Outcome.Invalid;
        } else {
            int256 figure = kind == 0
                ? second.figure
                : (second.figure > value
                        ? value - int256(_bound(seed, 1, 50))
                        : value + int256(_bound(seed, 1, 50)));
            expected[current] =
                RESOLVER.isGreater(figure, 2, value, decimals) ? Outcome.Yes : Outcome.No;
            RESOLVER.ruleFigure(current, figure, 2, proposerWasRight);
        }
        credited[proposerWasRight ? second.proposer : second.disputer] += 2 * BOND - BURN;
        held -= 2 * BOND;
        outcomeRulings++;
    }

    /// @notice Rules the first contest, alternating which side was right, then attempts to rule it
    ///         again, which must be refused.
    function _ruleContest() internal {
        OptimisticResolver.Proposal memory first = RESOLVER.eventOf(current).rounds[0];
        bool proposerWasRight = contestRulings % 2 == 0;
        RESOLVER.ruleContest(current, proposerWasRight);
        credited[proposerWasRight ? first.proposer : first.disputer] += 2 * BOND - BURN;
        held -= 2 * BOND;
        contestRulings++;
        _refused(
            abi.encodeCall(OptimisticResolver.ruleContest, (current, true)),
            abi.encodeWithSelector(OptimisticResolver.AlreadyRuled.selector, current)
        );
    }

    /// @notice Every actor withdraws whatever it is owed.
    function _withdrawAll() internal {
        for (uint256 i = 0; i < 3; i++) {
            uint256 owed = RESOLVER.owed(actors[i]);
            if (owed == 0) continue;
            vm.prank(actors[i]);
            RESOLVER.withdraw();
            withdrawn[actors[i]] += owed;
            paidOut += owed;
            withdrawals++;
        }
    }

    /// @notice Attempts a call the resolver must refuse, requiring exactly the refusal owed. An
    ///         accepted call is left in place, so the properties see what it did.
    /// @param data The call.
    /// @param expectedReason The refusal owed.
    function _refused(bytes memory data, bytes memory expectedReason) internal {
        (bool accepted, bytes memory reason) = address(RESOLVER).call(data);
        if (!accepted) {
            require(
                keccak256(reason) == keccak256(expectedReason),
                "a call was refused for the wrong reason"
            );
        }
    }
}

/// @title ResolutionInvariantsTest
/// @notice Whatever path an event takes: every bond is accounted for once; every account is owed
///         exactly what the paths it took part in imply; no event waiting for the arbiter has an
///         outcome; and every outcome reported is the one its settlement or ruling implied.
contract ResolutionInvariantsTest is Test {
    ResolutionHandler internal handler;

    /// @notice The handler, which deploys the system, as the only target.
    function setUp() public {
        vm.warp(1_800_000_000);
        handler = new ResolutionHandler();
        targetContract(address(handler));
    }

    /// @notice Every bond is held for a live contest, owed, withdrawn or burned, and the resolver
    ///         holds exactly what was posted less what was withdrawn.
    function invariant_bondsAreConserved() public view {
        OptimisticResolver resolver = handler.RESOLVER();
        uint256 balance = handler.DOLLAR().balanceOf(address(resolver));
        assertEq(
            balance,
            handler.posted() - handler.paidOut(),
            "bonds: the resolver holds other than what was posted"
        );
        uint256 owed;
        for (uint256 i = 0; i < 3; i++) {
            owed += resolver.owed(handler.actorAt(i));
        }
        assertEq(
            handler.held() + owed + resolver.burned(),
            balance,
            "bonds: a bond is counted twice or not at all"
        );
    }

    /// @notice Every account is owed, or has withdrawn, exactly what the handler credited it.
    function invariant_eachAccountIsOwedItsCredits() public view {
        OptimisticResolver resolver = handler.RESOLVER();
        for (uint256 i = 0; i < 3; i++) {
            address actor = handler.actorAt(i);
            assertEq(
                resolver.owed(actor) + handler.withdrawn(actor),
                handler.credited(actor),
                "credits: an account is owed other than what it earned"
            );
        }
    }

    /// @notice The event being driven has no outcome while it waits for the arbiter, and otherwise
    ///         the one its settlement or ruling implied.
    function invariant_outcomesAreTheOnesImplied() public view {
        bytes32 id = handler.current();
        assertTrue(
            handler.eventCount() > 0 || id == bytes32(0),
            "outcomes: an event is driven before any was sealed"
        );
        if (id != bytes32(0)) _checkOutcome(id);
    }

    /// @notice Closes each run: every event's outcome is the one implied, and the run took every path.
    /// @dev Finished events are checked here rather than after every call: an outcome is written once
    ///      and the handler never returns to a finished event, so nothing can change it within a run,
    ///      and reading every event after every call cost over three times the campaign's budget.
    function afterInvariant() public view {
        for (uint256 i = 0; i < handler.eventCount(); i++) {
            _checkOutcome(handler.eventIds(i));
        }
        assertGt(handler.settlements(), 0, "the campaign settled nothing");
        assertGt(handler.resets(), 0, "the campaign never reset an event");
        assertGt(handler.escalations(), 0, "the campaign never escalated an event");
        assertGt(handler.outcomeRulings(), 2, "the campaign never ruled all three kinds of outcome");
        assertGt(handler.contestRulings(), 1, "the campaign never ruled a contest both ways");
        assertGt(handler.withdrawals(), 0, "the campaign withdrew nothing");
    }

    /// @notice No outcome while waiting for the arbiter; otherwise the one implied.
    /// @param id The event.
    function _checkOutcome(bytes32 id) internal view {
        OptimisticResolver resolver = handler.RESOLVER();
        MarketFactory factory = handler.FACTORY();
        Outcome outcome = factory.outcomeOf(factory.condition(address(resolver), id));
        if (resolver.eventOf(id).pendingArbitration) {
            assertEq(
                uint8(outcome),
                uint8(Outcome.Unresolved),
                "outcomes: an event waiting for the arbiter has one"
            );
        }
        assertEq(
            uint8(outcome),
            uint8(handler.expected(id)),
            "outcomes: an outcome is not the one implied"
        );
    }
}
