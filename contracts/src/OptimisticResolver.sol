// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MarketFactory} from "./MarketFactory.sol";
import {Outcome} from "./PositionVault.sol";
import {ThresholdRegistry} from "./ThresholdRegistry.sol";

/// @title OptimisticResolver
/// @notice Resolves events sealed by one trusted sealer, by a bonded proposal of the published
///         figure. Once the figure is public, anyone may propose it with a bond; once the event's
///         deadline has passed with no figure, anyone may propose that it is invalid. A proposal
///         nobody disputes within the window settles: the outcome is derived from the figure and the
///         sealed threshold, reported to the market factory, and the bond is credited back.
/// @dev The protocol's rules, which a dispute enforces: a figure proposed before it was public is
///      wrong whatever its value; a figure is the one first published by the source the terms name;
///      invalid is right only when neither the primary nor the fallback source published the figure
///      by the deadline, or what was published is ambiguous. Disputes are not part of this contract
///      yet, so no market should name it as resolver until they are.
///
///      Every parameter is fixed at construction: a market's condition commits to this contract's
///      address, so a parameter that changed later would change what markets committed to. The bond
///      token is assumed plain — no fee, no rebase, no hooks — and one that delivers less than the
///      bond is refused. Settlement makes no token transfer: it credits the bond, and the proposer
///      withdraws it, so a token that stops moving delays a withdrawal, never an outcome.
contract OptimisticResolver {
    using SafeERC20 for IERC20;

    /// @notice A proposal for an event.
    /// @param proposer Who proposed it, and is owed its bond.
    /// @param proposedAt When, in Unix seconds.
    /// @param invalid Whether it proposes that the event is invalid rather than a figure.
    /// @param settled Whether it has settled.
    /// @param figure The figure proposed, scaled by `10**decimals`.
    /// @param decimals The decimals of `figure`.
    struct Proposal {
        address proposer;
        uint256 proposedAt;
        bool invalid;
        bool settled;
        int256 figure;
        uint8 decimals;
    }

    /// @notice The most decimals a proposed figure may carry.
    uint8 public constant MAX_DECIMALS = 18;

    /// @notice Where outcomes are reported.
    MarketFactory public immutable FACTORY;
    /// @notice Where thresholds are sealed.
    ThresholdRegistry public immutable REGISTRY;
    /// @notice The only sealer whose events this resolver resolves.
    address public immutable SEALER;
    /// @notice The token bonds are posted in.
    IERC20 public immutable BOND_TOKEN;
    /// @notice The bond every proposal posts.
    uint256 public immutable BOND;
    /// @notice How long, in seconds, a proposal stays open before it can settle.
    uint256 public immutable LIVENESS;

    mapping(bytes32 eventId => Proposal) internal proposals;

    /// @notice Bonds credited to each account and not yet withdrawn.
    mapping(address account => uint256) public owed;

    /// @notice Thrown when a constructor argument is zero.
    error ZeroParameter();
    /// @notice Thrown when an event is not sealed by the trusted sealer.
    /// @param eventId The event.
    error NotSealed(bytes32 eventId);
    /// @notice Thrown when a figure is proposed before it can be public.
    /// @param announcesAt The earliest instant it can be.
    error TooEarly(uint64 announcesAt);
    /// @notice Thrown when invalid is proposed before the deadline has passed.
    /// @param deadline The deadline.
    error BeforeDeadline(uint64 deadline);
    /// @notice Thrown when an event already has a proposal.
    /// @param eventId The event.
    error AlreadyProposed(bytes32 eventId);
    /// @notice Thrown when a figure carries more decimals than allowed.
    /// @param decimals What it carries.
    error DecimalsTooLarge(uint8 decimals);
    /// @notice Thrown when the bond that arrived is not the bond.
    /// @param expected The bond.
    /// @param received What arrived.
    error BondShortfall(uint256 expected, uint256 received);
    /// @notice Thrown when an event has no proposal to settle.
    /// @param eventId The event.
    error NoProposal(bytes32 eventId);
    /// @notice Thrown when an event's proposal has already settled.
    /// @param eventId The event.
    error AlreadySettled(bytes32 eventId);
    /// @notice Thrown when settling before the window closes.
    /// @param closesAt When it closes.
    error WindowOpen(uint256 closesAt);
    /// @notice Thrown when withdrawing with nothing owed.
    error NothingOwed();

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
    /// @notice Emitted when a proposal settles.
    /// @param eventId The event.
    /// @param outcome The outcome reported.
    event ProposalSettled(bytes32 indexed eventId, Outcome outcome);
    /// @notice Emitted when an account withdraws its credited bonds.
    /// @param account The account.
    /// @param amount How much.
    event Withdrawn(address indexed account, uint256 amount);

    /// @notice Fixes every parameter.
    /// @param factory Where outcomes are reported.
    /// @param registry Where thresholds are sealed.
    /// @param sealer The only sealer whose events are resolved.
    /// @param bondToken The token bonds are posted in.
    /// @param bond The bond every proposal posts.
    /// @param liveness How long a proposal stays open, in seconds.
    constructor(
        MarketFactory factory,
        ThresholdRegistry registry,
        address sealer,
        IERC20 bondToken,
        uint256 bond,
        uint256 liveness
    ) {
        if (
            address(factory) == address(0) || address(registry) == address(0)
                || sealer == address(0) || address(bondToken) == address(0) || bond == 0
                || liveness == 0
        ) {
            revert ZeroParameter();
        }
        FACTORY = factory;
        REGISTRY = registry;
        SEALER = sealer;
        BOND_TOKEN = bondToken;
        BOND = bond;
        LIVENESS = liveness;
    }

    /// @notice Proposes the figure an event's terms name, as first published, posting the bond.
    /// @param eventId The event.
    /// @param figure The figure, scaled by `10**decimals`.
    /// @param decimals Its decimals; at most eighteen.
    /// @custom:access anyone
    function proposeFigure(bytes32 eventId, int256 figure, uint8 decimals) external {
        (,, uint64 announcesAt,) = _sealed(eventId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < announcesAt) {
            revert TooEarly(announcesAt);
        }
        if (decimals > MAX_DECIMALS) {
            revert DecimalsTooLarge(decimals);
        }
        _record(eventId, false, figure, decimals);
        emit FigureProposed(eventId, msg.sender, figure, decimals);
        _pullBond();
    }

    /// @notice Proposes that an event is invalid, posting the bond. Only once its deadline has passed.
    /// @param eventId The event.
    /// @custom:access anyone
    function proposeInvalid(bytes32 eventId) external {
        (,,, uint64 deadline) = _sealed(eventId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= deadline) {
            revert BeforeDeadline(deadline);
        }
        _record(eventId, true, 0, 0);
        emit InvalidProposed(eventId, msg.sender);
        _pullBond();
    }

    /// @notice Settles a proposal once its window has closed: reports the outcome it implies and
    ///         credits the bond to its proposer.
    /// @param eventId The event.
    /// @custom:access anyone
    function settle(bytes32 eventId) external {
        Proposal storage proposal = proposals[eventId];
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
        Outcome outcome = Outcome.Invalid;
        if (!proposal.invalid) {
            (int256 value, uint8 valueDecimals,,) = _sealed(eventId);
            outcome = isGreater(proposal.figure, proposal.decimals, value, valueDecimals)
                ? Outcome.Yes
                : Outcome.No;
        }
        emit ProposalSettled(eventId, outcome);
        FACTORY.reportOutcome(eventId, outcome);
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

    /// @notice An event's proposal.
    /// @param eventId The event.
    /// @return The proposal; its proposer is zero if there is none.
    function proposalOf(bytes32 eventId) external view returns (Proposal memory) {
        return proposals[eventId];
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

    /// @notice Records an event's proposal, refusing a second one.
    /// @param eventId The event.
    /// @param invalid Whether it proposes invalid.
    /// @param figure The figure, if not.
    /// @param decimals Its decimals.
    function _record(bytes32 eventId, bool invalid, int256 figure, uint8 decimals) internal {
        if (proposals[eventId].proposer != address(0)) {
            revert AlreadyProposed(eventId);
        }
        proposals[eventId] = Proposal(msg.sender, block.timestamp, invalid, false, figure, decimals);
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
