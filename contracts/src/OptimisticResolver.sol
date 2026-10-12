// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MarketFactory} from "./MarketFactory.sol";
import {Outcome} from "./PositionVault.sol";
import {ThresholdRegistry} from "./ThresholdRegistry.sol";

/// @title OptimisticResolver
/// @notice Resolves events sealed by one trusted sealer, by a bonded proposal of the published
///         figure. Once the figure is public, anyone may propose it with a bond; once the event's
///         deadline has passed with no figure, anyone may propose that it is invalid. A proposal
///         nobody disputes within the window settles: the outcome is derived from the figure and the
///         sealed threshold, reported to the market factory, and the bond is credited back.
///
///         Anyone may dispute a proposal within its window by posting an equal bond. The first
///         dispute of an event discards its proposal and reopens it for a second; a dispute of the
///         second sends the event to the arbiter, who rules its figure, or that it is invalid, and the
///         outcome that implies is reported. The arbiter also rules each contest — a proposal and the
///         dispute against it — and whoever was right is credited both bonds less a fixed burn.
/// @dev The protocol's rules, which disputes enforce: a figure proposed before it was public is
///      wrong whatever its value; a figure is the one first published by the source the terms name;
///      invalid is right only when neither the primary nor the fallback source published the figure
///      by the deadline, or what was published is ambiguous, or the arbiter let its timeout pass. The same rules bind the arbiter: it
///      rules invalid only after the deadline, and it may rule a proposer right only for the answer
///      that proposer gave. The design follows UMA's optimistic oracle: bonds posted by both sides,
///      a share burned so that disputing oneself always costs.
///
///      The arbiter's reach, as protocol: in every function anyone may call, the arbiter is anyone,
///      with no privilege. Beyond them it holds three rulings — an event's outcome only while the
///      event is pending arbitration, and a disputed, unruled contest's bonds — once each, and every
///      ruling carries its reason, stored with the time it was made. It changes no parameter and
///      reaches no other contract. Reasons are stored rather than only logged, because old logs may
///      not be served while current storage always is.
///
///      Every way an event can stall has an exit anyone may take, with no bond and no privilege: an
///      event nobody resolves expires invalid after its deadline and a grace period; an event the
///      arbiter never rules expires invalid once its timeout passes, never before the deadline, with
///      both bonds returned unburned, since silence judges no one; a first contest the arbiter never
///      rules is released, each bond to its poster. The resolver's liveness rests on `settle`,
///      `expire` and `release`, which anyone may call.
///
///      Every parameter is fixed at construction: a market's condition commits to this contract's
///      address, so a parameter that changed later would change what markets committed to. The bond
///      token is assumed plain — no fee, no rebase, no hooks — and one that delivers less than the
///      bond is refused. Neither settlement nor a ruling makes a token transfer: bonds are credited
///      and withdrawn, and the burn is only counted, so a token that stops moving delays a
///      withdrawal, never an outcome. What is burned stays here, and nothing can move it.
contract OptimisticResolver {
    using SafeERC20 for IERC20;

    /// @notice A proposal for an event, and the dispute against it.
    /// @param proposer Who proposed it.
    /// @param proposedAt When, in Unix seconds.
    /// @param invalid Whether it proposes that the event is invalid rather than a figure.
    /// @param settled Whether the event was settled by it, undisputed, or ruled after it.
    /// @param figure The figure proposed, scaled by `10**decimals`.
    /// @param decimals The decimals of `figure`.
    /// @param disputer Who disputed it; zero while undisputed.
    /// @param ruled Whether the contest between its proposer and disputer is closed: ruled by the
    ///        arbiter, or released after its timeout, which leaves `reason` empty — a ruling never
    ///        does.
    /// @param ruledAt When that contest was ruled, in Unix seconds.
    /// @param reason Why it was ruled as it was; for the second round, kept with the event's outcome.
    struct Proposal {
        address proposer;
        uint256 proposedAt;
        bool invalid;
        bool settled;
        int256 figure;
        uint8 decimals;
        address disputer;
        bool ruled;
        uint64 ruledAt;
        string reason;
    }

    /// @notice Where an event stands.
    /// @param round The round now open: zero until a first dispute, then one.
    /// @param pendingArbitration Whether round one was disputed and the arbiter has yet to rule.
    /// @param rounds Each round's proposal.
    /// @param outcomeReason Why the arbiter ruled the outcome it did, if it ruled one.
    struct EventState {
        uint8 round;
        bool pendingArbitration;
        Proposal[2] rounds;
        string outcomeReason;
    }

    /// @notice The most decimals a figure may carry.
    uint8 public constant MAX_DECIMALS = 18;

    /// @notice The longest reason a ruling may carry, in bytes, so the gas a ruling needs is bounded.
    uint256 public constant MAX_REASON = 1024;

    /// @notice Where outcomes are reported.
    MarketFactory public immutable FACTORY;
    /// @notice Where thresholds are sealed.
    ThresholdRegistry public immutable REGISTRY;
    /// @notice The only sealer whose events this resolver resolves.
    address public immutable SEALER;
    /// @notice Who rules disputed events and every contest.
    address public immutable ARBITER;
    /// @notice The token bonds are posted in.
    IERC20 public immutable BOND_TOKEN;
    /// @notice The bond every proposal and every dispute posts.
    uint256 public immutable BOND;
    /// @notice What is burned of a losing bond: never zero, never above the bond.
    uint256 public immutable BURN;
    /// @notice How long, in seconds, a proposal stays open to dispute before it can settle.
    uint256 public immutable LIVENESS;
    /// @notice How long, in seconds, after the deadline (or a reset's window) anyone may still propose
    ///         before an event with nothing open can be expired.
    uint256 public immutable EXPIRY;
    /// @notice How long, in seconds, the arbiter has to rule a deadlocked event or a disputed contest.
    uint256 public immutable ARBITER_TIMEOUT;

    mapping(bytes32 eventId => EventState) internal events;

    /// @notice Bonds credited to each account and not yet withdrawn.
    mapping(address account => uint256) public owed;

    /// @notice Everything burned so far, which stays in this contract for good.
    uint256 public burned;

    /// @notice Thrown when a constructor argument is zero.
    error ZeroParameter();
    /// @notice Thrown when the burn exceeds the bond.
    /// @param burn The burn.
    /// @param bond The bond.
    error BurnAboveBond(uint256 burn, uint256 bond);
    /// @notice Thrown when anyone but the arbiter rules.
    error NotArbiter();
    /// @notice Thrown when an event is not sealed by the trusted sealer.
    /// @param eventId The event.
    error NotSealed(bytes32 eventId);
    /// @notice Thrown when a figure is proposed before it can be public.
    /// @param announcesAt The earliest instant it can be.
    error TooEarly(uint64 announcesAt);
    /// @notice Thrown when invalid is proposed or ruled before the deadline has passed.
    /// @param deadline The deadline.
    error BeforeDeadline(uint64 deadline);
    /// @notice Thrown when the open round already has a proposal.
    /// @param eventId The event.
    error AlreadyProposed(bytes32 eventId);
    /// @notice Thrown when a figure carries more decimals than allowed.
    /// @param decimals What it carries.
    error DecimalsTooLarge(uint8 decimals);
    /// @notice Thrown when the bond that arrived is not the bond.
    /// @param expected The bond.
    /// @param received What arrived.
    error BondShortfall(uint256 expected, uint256 received);
    /// @notice Thrown when the open round has no proposal.
    /// @param eventId The event.
    error NoProposal(bytes32 eventId);
    /// @notice Thrown when an event has already settled.
    /// @param eventId The event.
    error AlreadySettled(bytes32 eventId);
    /// @notice Thrown when settling before the window closes.
    /// @param closesAt When it closes.
    error WindowOpen(uint256 closesAt);
    /// @notice Thrown when disputing once the window has closed.
    /// @param closesAt When it closed.
    error WindowClosed(uint256 closesAt);
    /// @notice Thrown when acting on an event that waits for the arbiter.
    /// @param eventId The event.
    error PendingArbitration(bytes32 eventId);
    /// @notice Thrown when ruling the outcome of an event that is not waiting for the arbiter.
    /// @param eventId The event.
    error NotPending(bytes32 eventId);
    /// @notice Thrown when ruling a contest that has no dispute.
    /// @param eventId The event.
    error NotDisputed(bytes32 eventId);
    /// @notice Thrown when ruling a contest twice.
    /// @param eventId The event.
    error AlreadyRuled(bytes32 eventId);
    /// @notice Thrown when a proposer is ruled right for an answer it did not give.
    error NotTheRuledAnswer();
    /// @notice Thrown when withdrawing with nothing owed.
    error NothingOwed();
    /// @notice Thrown when a duration could overflow a clock.
    /// @param duration The duration.
    error DurationTooLong(uint256 duration);
    /// @notice Thrown when proposing after an event's expiry.
    /// @param expiresAt When it expired.
    error EventExpired(uint256 expiresAt);
    /// @notice Thrown when expiring an event before its time.
    /// @param at When it can be expired.
    error NotExpired(uint256 at);
    /// @notice Thrown when expiring an event whose open round has a proposal to settle.
    /// @param eventId The event.
    error ProposalOpen(bytes32 eventId);
    /// @notice Thrown when ruling after the arbiter's timeout.
    /// @param timeout When it ran out.
    error TimedOut(uint256 timeout);
    /// @notice Thrown when releasing a contest before the arbiter's timeout.
    /// @param timeout When it runs out.
    error NotTimedOut(uint256 timeout);
    /// @notice Thrown when a ruling carries no reason.
    error EmptyReason();
    /// @notice Thrown when a ruling's reason is longer than allowed.
    /// @param length Its length, in bytes.
    error ReasonTooLong(uint256 length);

    /// @notice Emitted when a figure is proposed.
    /// @param eventId The event.
    /// @param proposer Who proposed it.
    /// @param figure The figure, scaled by `10**decimals`.
    /// @param decimals Its decimals.
    event FigureProposed(
        bytes32 indexed eventId, address indexed proposer, int256 figure, uint8 decimals
    );
    /// @notice Emitted when an event is proposed invalid.
    /// @param eventId The event.
    /// @param proposer Who proposed it.
    event InvalidProposed(bytes32 indexed eventId, address indexed proposer);
    /// @notice Emitted when a proposal is disputed.
    /// @param eventId The event.
    /// @param round The round disputed.
    /// @param disputer Who disputed it.
    event Disputed(bytes32 indexed eventId, uint8 round, address indexed disputer);
    /// @notice Emitted when an undisputed proposal settles.
    /// @param eventId The event.
    /// @param outcome The outcome reported.
    event ProposalSettled(bytes32 indexed eventId, Outcome outcome);
    /// @notice Emitted when the arbiter rules an event's outcome.
    /// @param eventId The event.
    /// @param outcome The outcome reported.
    /// @param reason Why.
    event OutcomeRuled(bytes32 indexed eventId, Outcome outcome, string reason);
    /// @notice Emitted when the arbiter rules a contest.
    /// @param eventId The event.
    /// @param round The round whose contest was ruled.
    /// @param winner Who was right, and is credited.
    /// @param credited What the winner is credited.
    /// @param burn What is burned of the loser's bond.
    /// @param reason Why.
    event ContestRuled(
        bytes32 indexed eventId,
        uint8 round,
        address indexed winner,
        uint256 credited,
        uint256 burn,
        string reason
    );
    /// @notice Emitted when an event expires invalid.
    /// @param eventId The event.
    /// @param arbiterSilent True if the arbiter let its timeout pass; false if nobody resolved it.
    event Expired(bytes32 indexed eventId, bool arbiterSilent);
    /// @notice Emitted when a first contest the arbiter never ruled is released.
    /// @param eventId The event.
    event ContestReleased(bytes32 indexed eventId);
    /// @notice Emitted when an account withdraws its credited bonds.
    /// @param account The account.
    /// @param amount How much.
    event Withdrawn(address indexed account, uint256 amount);

    /// @notice Only the arbiter.
    modifier onlyArbiter() {
        if (msg.sender != ARBITER) {
            revert NotArbiter();
        }
        _;
    }

    /// @notice Fixes every parameter.
    /// @param factory Where outcomes are reported.
    /// @param registry Where thresholds are sealed.
    /// @param sealer The only sealer whose events are resolved.
    /// @param arbiter Who rules disputed events and every contest.
    /// @param bondToken The token bonds are posted in.
    /// @param bond The bond every proposal and dispute posts.
    /// @param burn What is burned of a losing bond.
    /// @param liveness How long a proposal stays open, in seconds.
    /// @param expiry How long after the deadline anyone may still propose, in seconds.
    /// @param arbiterTimeout How long the arbiter has to rule, in seconds.
    constructor(
        MarketFactory factory,
        ThresholdRegistry registry,
        address sealer,
        address arbiter,
        IERC20 bondToken,
        uint256 bond,
        uint256 burn,
        uint256 liveness,
        uint256 expiry,
        uint256 arbiterTimeout
    ) {
        if (
            address(factory) == address(0) || address(registry) == address(0)
                || sealer == address(0) || arbiter == address(0) || address(bondToken) == address(0)
                || bond == 0 || burn == 0 || liveness == 0 || expiry == 0 || arbiterTimeout == 0
        ) {
            revert ZeroParameter();
        }
        uint256 longest = liveness > expiry ? liveness : expiry;
        if (arbiterTimeout > longest) longest = arbiterTimeout;
        if (longest > type(uint64).max) {
            revert DurationTooLong(longest);
        }
        if (burn > bond) {
            revert BurnAboveBond(burn, bond);
        }
        FACTORY = factory;
        REGISTRY = registry;
        SEALER = sealer;
        ARBITER = arbiter;
        BOND_TOKEN = bondToken;
        BOND = bond;
        BURN = burn;
        LIVENESS = liveness;
        EXPIRY = expiry;
        ARBITER_TIMEOUT = arbiterTimeout;
    }

    /// @notice Proposes the figure an event's terms name, as first published, posting the bond.
    /// @param eventId The event.
    /// @param figure The figure, scaled by `10**decimals`.
    /// @param decimals Its decimals; at most eighteen.
    /// @custom:access anyone
    function proposeFigure(bytes32 eventId, int256 figure, uint8 decimals) external {
        (,, uint64 announcesAt, uint64 deadline) = _sealed(eventId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < announcesAt) {
            revert TooEarly(announcesAt);
        }
        if (decimals > MAX_DECIMALS) {
            revert DecimalsTooLarge(decimals);
        }
        _record(eventId, deadline, false, figure, decimals);
        emit FigureProposed(eventId, msg.sender, figure, decimals);
        _pullBond();
    }

    /// @notice Proposes that an event is invalid, posting the bond. Only once its deadline has passed.
    /// @param eventId The event.
    /// @custom:access anyone
    function proposeInvalid(bytes32 eventId) external {
        uint64 deadline = _requireAfterDeadline(eventId);
        _record(eventId, deadline, true, 0, 0);
        emit InvalidProposed(eventId, msg.sender);
        _pullBond();
    }

    /// @notice Disputes the open round's proposal within its window, posting the bond. A first
    ///         dispute reopens the event for a second proposal; a second sends it to the arbiter.
    /// @param eventId The event.
    /// @custom:access anyone
    function dispute(bytes32 eventId) external {
        EventState storage state = _open(eventId);
        uint8 round = state.round;
        Proposal storage proposal = state.rounds[round];
        if (proposal.proposer == address(0)) {
            revert NoProposal(eventId);
        }
        if (proposal.settled) {
            revert AlreadySettled(eventId);
        }
        uint256 closesAt = proposal.proposedAt + LIVENESS;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= closesAt) {
            revert WindowClosed(closesAt);
        }
        proposal.disputer = msg.sender;
        if (round == 0) {
            state.round = 1;
        } else {
            state.pendingArbitration = true;
        }
        emit Disputed(eventId, round, msg.sender);
        _pullBond();
    }

    /// @notice Settles the open round's proposal once its window has closed undisputed: reports the
    ///         outcome it implies and credits the bond to its proposer.
    /// @param eventId The event.
    /// @custom:access anyone
    function settle(bytes32 eventId) external {
        EventState storage state = _open(eventId);
        Proposal storage proposal = state.rounds[state.round];
        if (proposal.proposer == address(0)) {
            revert NoProposal(eventId);
        }
        if (proposal.settled) {
            revert AlreadySettled(eventId);
        }
        uint256 closesAt = proposal.proposedAt + LIVENESS;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < closesAt) {
            revert WindowOpen(closesAt);
        }
        proposal.settled = true;
        owed[proposal.proposer] += BOND;
        Outcome outcome = proposal.invalid
            ? Outcome.Invalid
            : _outcomeOf(eventId, proposal.figure, proposal.decimals);
        emit ProposalSettled(eventId, outcome);
        FACTORY.reportOutcome(eventId, outcome);
    }

    /// @notice Rules the figure of an event waiting for the arbiter, reports the outcome it implies,
    ///         and rules the contest over the second proposal.
    /// @param eventId The event.
    /// @param figure The figure, scaled by `10**decimals`.
    /// @param decimals Its decimals; at most eighteen.
    /// @param proposerWasRight Whether the second proposal was right; only if it proposed this
    ///        figure, by value.
    /// @param reason Why: the source, the figure it published, why the proposal was right or wrong.
    /// @custom:access arbiter
    function ruleFigure(
        bytes32 eventId,
        int256 figure,
        uint8 decimals,
        bool proposerWasRight,
        string calldata reason
    ) external onlyArbiter {
        if (decimals > MAX_DECIMALS) {
            revert DecimalsTooLarge(decimals);
        }
        Proposal storage proposal = _pending(eventId);
        _requireBeforeOutcomeTimeout(eventId);
        if (
            proposerWasRight
                && (proposal.invalid
                    || isGreater(figure, decimals, proposal.figure, proposal.decimals)
                    || isGreater(proposal.figure, proposal.decimals, figure, decimals))
        ) {
            revert NotTheRuledAnswer();
        }
        _rule(eventId, proposerWasRight, _outcomeOf(eventId, figure, decimals), reason);
    }

    /// @notice Rules that an event waiting for the arbiter is invalid, once its deadline has passed,
    ///         reports it, and rules the contest over the second proposal.
    /// @param eventId The event.
    /// @param proposerWasRight Whether the second proposal was right; only if it proposed invalid.
    /// @param reason Why: what the sources published by the deadline, or why it was ambiguous.
    /// @custom:access arbiter
    function ruleInvalid(bytes32 eventId, bool proposerWasRight, string calldata reason)
        external
        onlyArbiter
    {
        Proposal storage proposal = _pending(eventId);
        _requireAfterDeadline(eventId);
        _requireBeforeOutcomeTimeout(eventId);
        if (proposerWasRight && !proposal.invalid) {
            revert NotTheRuledAnswer();
        }
        _rule(eventId, proposerWasRight, Outcome.Invalid, reason);
    }

    /// @notice Rules the contest over an event's first proposal, once it was disputed.
    /// @param eventId The event.
    /// @param proposerWasRight Whether the first proposal was right.
    /// @param reason Why.
    /// @custom:access arbiter
    function ruleContest(bytes32 eventId, bool proposerWasRight, string calldata reason)
        external
        onlyArbiter
    {
        Proposal storage proposal = events[eventId].rounds[0];
        if (proposal.disputer == address(0)) {
            revert NotDisputed(eventId);
        }
        if (proposal.ruled) {
            revert AlreadyRuled(eventId);
        }
        uint256 timeout = contestTimeout(eventId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= timeout) {
            revert TimedOut(timeout);
        }
        _requireReason(reason);
        proposal.reason = reason;
        _ruleContest(eventId, 0, proposerWasRight, reason);
    }

    /// @notice Ends an event that nobody, or no arbiter, resolved: reports it invalid. Either the event
    ///         has nothing open and its expiry has passed, or it waits for an arbiter whose timeout has
    ///         passed — and then both bonds of the second contest go back to their posters, unburned.
    /// @param eventId The event.
    /// @custom:access anyone
    function expire(bytes32 eventId) external {
        EventState storage state = events[eventId];
        (,,, uint64 deadline) = _sealed(eventId);
        if (state.pendingArbitration) {
            uint256 timeout = _outcomeTimeout(state, deadline);
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp < timeout) {
                revert NotExpired(timeout);
            }
            Proposal storage second = state.rounds[1];
            state.pendingArbitration = false;
            second.settled = true;
            second.ruled = true;
            second.ruledAt = SafeCast.toUint64(block.timestamp);
            owed[second.proposer] += BOND;
            owed[second.disputer] += BOND;
            emit Expired(eventId, true);
            FACTORY.reportOutcome(eventId, Outcome.Invalid);
            return;
        }
        Proposal storage open = state.rounds[state.round];
        if (open.settled) {
            revert AlreadySettled(eventId);
        }
        if (open.proposer != address(0)) {
            revert ProposalOpen(eventId);
        }
        uint256 expiresAt_ = _expiresAt(state, deadline);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= expiresAt_) {
            revert NotExpired(expiresAt_);
        }
        open.settled = true;
        emit Expired(eventId, false);
        FACTORY.reportOutcome(eventId, Outcome.Invalid);
    }

    /// @notice Releases a first contest the arbiter never ruled: each poster is credited its own bond.
    /// @param eventId The event.
    /// @custom:access anyone
    function release(bytes32 eventId) external {
        Proposal storage first = events[eventId].rounds[0];
        if (first.disputer == address(0)) {
            revert NotDisputed(eventId);
        }
        if (first.ruled) {
            revert AlreadyRuled(eventId);
        }
        uint256 timeout = contestTimeout(eventId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < timeout) {
            revert NotTimedOut(timeout);
        }
        first.ruled = true;
        first.ruledAt = SafeCast.toUint64(block.timestamp);
        owed[first.proposer] += BOND;
        owed[first.disputer] += BOND;
        emit ContestReleased(eventId);
    }

    /// @notice Pays the caller every bond credited to it.
    /// @custom:access anyone
    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) {
            revert NothingOwed();
        }
        owed[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        BOND_TOKEN.safeTransfer(msg.sender, amount);
    }

    /// @notice The open round's proposal.
    /// @param eventId The event.
    /// @return The proposal; its proposer is zero if there is none.
    function proposalOf(bytes32 eventId) external view returns (Proposal memory) {
        EventState storage state = events[eventId];
        return state.rounds[state.round];
    }

    /// @notice Where an event stands: its round, whether it waits for the arbiter, both rounds.
    /// @param eventId The event.
    /// @return The state.
    function eventOf(bytes32 eventId) external view returns (EventState memory) {
        return events[eventId];
    }

    /// @notice The last instant anything may be proposed for an event; after it, an event with nothing
    ///         open can be expired. Its deadline plus the expiry, or, after a reset, the disputed
    ///         window's close plus the expiry if that is later.
    /// @param eventId The event, sealed by the trusted sealer.
    /// @return The instant.
    function expiresAt(bytes32 eventId) external view returns (uint256) {
        (,,, uint64 deadline) = _sealed(eventId);
        return _expiresAt(events[eventId], deadline);
    }

    /// @notice The instant the arbiter's time to rule an event's outcome runs out: the second
    ///         proposal's window close or the deadline, whichever is later, plus the timeout.
    /// @param eventId The event, sealed by the trusted sealer.
    /// @return The instant.
    function outcomeTimeout(bytes32 eventId) public view returns (uint256) {
        (,,, uint64 deadline) = _sealed(eventId);
        return _outcomeTimeout(events[eventId], deadline);
    }

    /// @notice The instant the arbiter's time to rule an event's first contest runs out: its window's
    ///         close plus the timeout.
    /// @param eventId The event.
    /// @return The instant.
    function contestTimeout(bytes32 eventId) public view returns (uint256) {
        return events[eventId].rounds[0].proposedAt + LIVENESS + ARBITER_TIMEOUT;
    }

    /// @notice Whether `figure / 10**figureDecimals` is greater than `value / 10**valueDecimals`,
    ///         exactly, for every value and every pair of decimals up to eighteen. It never reverts.
    /// @dev Compares in integers by dividing the side with more decimals, rounding toward negative
    ///      infinity, so nothing is ever multiplied and nothing can overflow. With fewer decimals on
    ///      the figure, an integer exceeds a number exactly when it exceeds that number's floor; with
    ///      more, the figure's floor exceeds the value, or equals it with something left over.
    /// @param figure The figure, scaled.
    /// @param figureDecimals Its decimals.
    /// @param value The threshold, scaled.
    /// @param valueDecimals Its decimals.
    /// @return True if the figure is greater.
    function isGreater(int256 figure, uint8 figureDecimals, int256 value, uint8 valueDecimals)
        public
        pure
        returns (bool)
    {
        if (figureDecimals <= valueDecimals) {
            return figure > _floorDiv(value, int256(10) ** (valueDecimals - figureDecimals));
        }
        int256 scale = int256(10) ** (figureDecimals - valueDecimals);
        int256 floor = _floorDiv(figure, scale);
        return floor > value || (floor == value && figure % scale != 0);
    }

    /// @notice See `expiresAt`.
    /// @param state The event's state.
    /// @param deadline Its deadline.
    /// @return The instant.
    function _expiresAt(EventState storage state, uint64 deadline) internal view returns (uint256) {
        uint256 from = deadline;
        if (state.round == 1) {
            uint256 reopened = state.rounds[0].proposedAt + LIVENESS;
            if (reopened > from) from = reopened;
        }
        return from + EXPIRY;
    }

    /// @notice See `outcomeTimeout`.
    /// @param state The event's state.
    /// @param deadline Its deadline.
    /// @return The instant.
    function _outcomeTimeout(EventState storage state, uint64 deadline)
        internal
        view
        returns (uint256)
    {
        uint256 closed = state.rounds[1].proposedAt + LIVENESS;
        return (closed > deadline ? closed : deadline) + ARBITER_TIMEOUT;
    }

    /// @notice Refuses a ruling of an event's outcome once the arbiter's time has run out.
    /// @param eventId The event.
    function _requireBeforeOutcomeTimeout(bytes32 eventId) internal view {
        uint256 timeout = outcomeTimeout(eventId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= timeout) {
            revert TimedOut(timeout);
        }
    }

    /// @notice An event not waiting for the arbiter.
    /// @param eventId The event.
    /// @return state Its state.
    function _open(bytes32 eventId) internal view returns (EventState storage state) {
        state = events[eventId];
        if (state.pendingArbitration) {
            revert PendingArbitration(eventId);
        }
    }

    /// @notice The disputed second proposal of an event waiting for the arbiter.
    /// @param eventId The event.
    /// @return The proposal.
    function _pending(bytes32 eventId) internal view returns (Proposal storage) {
        EventState storage state = events[eventId];
        if (!state.pendingArbitration) {
            revert NotPending(eventId);
        }
        return state.rounds[1];
    }

    /// @notice Ends an event's arbitration: rules the second contest and reports the outcome.
    /// @param eventId The event.
    /// @param proposerWasRight Whether the second proposal was right.
    /// @param outcome The outcome ruled.
    /// @param reason Why, kept with the event's outcome.
    function _rule(bytes32 eventId, bool proposerWasRight, Outcome outcome, string calldata reason)
        internal
    {
        _requireReason(reason);
        EventState storage state = events[eventId];
        state.pendingArbitration = false;
        state.rounds[1].settled = true;
        state.outcomeReason = reason;
        _ruleContest(eventId, 1, proposerWasRight, reason);
        emit OutcomeRuled(eventId, outcome, reason);
        FACTORY.reportOutcome(eventId, outcome);
    }

    /// @notice Credits the winner of a contest both bonds less the burn, and counts the burn.
    /// @param eventId The event.
    /// @param round The round whose contest it is.
    /// @param proposerWasRight Whether the proposer was right.
    /// @param reason Why.
    function _ruleContest(
        bytes32 eventId,
        uint8 round,
        bool proposerWasRight,
        string calldata reason
    ) internal {
        Proposal storage proposal = events[eventId].rounds[round];
        proposal.ruled = true;
        proposal.ruledAt = SafeCast.toUint64(block.timestamp);
        address winner = proposerWasRight ? proposal.proposer : proposal.disputer;
        uint256 credited = 2 * BOND - BURN;
        owed[winner] += credited;
        burned += BURN;
        emit ContestRuled(eventId, round, winner, credited, BURN, reason);
    }

    /// @notice Refuses a ruling with no reason, or one longer than allowed.
    /// @param reason The reason.
    function _requireReason(string calldata reason) internal pure {
        uint256 length = bytes(reason).length;
        if (length == 0) {
            revert EmptyReason();
        }
        if (length > MAX_REASON) {
            revert ReasonTooLong(length);
        }
    }

    /// @notice The outcome a figure implies against an event's sealed threshold.
    /// @param eventId The event.
    /// @param figure The figure, scaled.
    /// @param decimals Its decimals.
    /// @return Yes if the figure is greater than the threshold, no otherwise.
    function _outcomeOf(bytes32 eventId, int256 figure, uint8 decimals)
        internal
        view
        returns (Outcome)
    {
        (int256 value, uint8 valueDecimals,,) = _sealed(eventId);
        return isGreater(figure, decimals, value, valueDecimals) ? Outcome.Yes : Outcome.No;
    }

    /// @notice Refuses an event whose deadline has not passed.
    /// @param eventId The event.
    /// @return deadline The deadline.
    function _requireAfterDeadline(bytes32 eventId) internal view returns (uint64 deadline) {
        (,,, deadline) = _sealed(eventId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= deadline) {
            revert BeforeDeadline(deadline);
        }
    }

    /// @notice Reads an event's sealed threshold, refusing an event the trusted sealer did not seal.
    /// @param eventId The event.
    /// @return value The threshold, scaled.
    /// @return decimals Its decimals.
    /// @return announcesAt The earliest instant the figure may be public.
    /// @return deadline The last instant it may be published.
    function _sealed(bytes32 eventId)
        internal
        view
        returns (int256 value, uint8 decimals, uint64 announcesAt, uint64 deadline)
    {
        address sealer;
        // The seal's block is the one field a resolver has no use for.
        // forge-lint: disable-next-line(unused-return)
        (sealer,, value, decimals, announcesAt, deadline) = REGISTRY.thresholdOf(eventId);
        if (sealer != SEALER) {
            revert NotSealed(eventId);
        }
    }

    /// @notice Records the open round's proposal, refusing a second one and an event waiting for
    ///         the arbiter.
    /// @param eventId The event.
    /// @param deadline Its deadline.
    /// @param invalid Whether it proposes invalid.
    /// @param figure The figure, if not.
    /// @param decimals Its decimals.
    function _record(bytes32 eventId, uint64 deadline, bool invalid, int256 figure, uint8 decimals)
        internal
    {
        EventState storage state = _open(eventId);
        uint256 expiresAt_ = _expiresAt(state, deadline);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > expiresAt_) {
            revert EventExpired(expiresAt_);
        }
        Proposal storage proposal = state.rounds[state.round];
        if (proposal.proposer != address(0)) {
            revert AlreadyProposed(eventId);
        }
        proposal.proposer = msg.sender;
        proposal.proposedAt = block.timestamp;
        proposal.invalid = invalid;
        proposal.figure = figure;
        proposal.decimals = decimals;
    }

    /// @notice Pulls the bond from the caller and requires that exactly the bond arrived.
    function _pullBond() internal {
        uint256 before = BOND_TOKEN.balanceOf(address(this));
        BOND_TOKEN.safeTransferFrom(msg.sender, address(this), BOND);
        uint256 balance = BOND_TOKEN.balanceOf(address(this));
        uint256 received = balance > before ? balance - before : 0;
        if (received != BOND) {
            revert BondShortfall(BOND, received);
        }
    }

    /// @notice Divides, rounding toward negative infinity.
    /// @param numerator The numerator.
    /// @param denominator A positive denominator.
    /// @return The floor of their quotient.
    function _floorDiv(int256 numerator, int256 denominator) internal pure returns (int256) {
        int256 quotient = numerator / denominator;
        return numerator % denominator != 0 && numerator < 0 ? quotient - 1 : quotient;
    }
}
