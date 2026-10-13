// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {TestCollateral} from "./PositionVault.t.sol";
import {TestStock} from "./MarketFactory.t.sol";

/// @title SkimmingDollar
/// @notice A dollar that keeps one unit of every transfer, and can be switched off, for tests only.
contract SkimmingDollar is TestCollateral {
    bool internal skimming;
    bool internal stopped;

    /// @notice Starts keeping one unit of every transfer.
    function skim() external {
        skimming = true;
    }

    /// @notice Refuses every transfer from now on, as a paused token would.
    function stop() external {
        stopped = true;
    }

    /// @notice Accepts transfers again.
    function resume() external {
        stopped = false;
    }

    /// @notice Moves value, short by one unit while skimming, and not at all while stopped.
    /// @param from The sender.
    /// @param to The recipient.
    /// @param value How much.
    function _update(address from, address to, uint256 value) internal override {
        require(!stopped, "stopped");
        if (skimming && from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0xdead), 1);
            value -= 1;
        }
        super._update(from, to, value);
    }
}

/// @title OptimisticResolverTest
/// @notice A sealed event's figure, proposed with a bond once it can be public, settles after the
///         window into the outcome the sealed threshold implies, and the bond is credited back.
contract OptimisticResolverTest is Test {
    uint256 internal constant BOND = 500e6;
    uint256 internal constant LIVENESS = 2 hours;

    address internal sealer = makeAddr("sealer");
    address internal proposer = makeAddr("proposer");
    address internal holder = makeAddr("holder");

    ThresholdRegistry internal registry;
    MarketFactory internal factory;
    SkimmingDollar internal dollar;
    OptimisticResolver internal resolver;
    ThresholdRegistry.Threshold internal threshold;
    bytes32 internal eventId;

    /// @notice A sealed event with threshold 1.23, a resolver trusting its sealer, and a funded
    ///         proposer.
    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new ThresholdRegistry();
        factory = new MarketFactory();
        dollar = new SkimmingDollar();
        resolver = new OptimisticResolver(
            factory,
            registry,
            sealer,
            address(this),
            IERC20(address(dollar)),
            BOND,
            BOND / 5,
            LIVENESS,
            7 days,
            7 days
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
        dollar.mint(proposer, 10 * BOND);
        vm.prank(proposer);
        dollar.approve(address(resolver), type(uint256).max);
    }

    /// @notice The constructor refuses every zero parameter.
    function test_RevertWhen_aParameterIsZero() public {
        IERC20 token = IERC20(address(dollar));
        vm.expectRevert(OptimisticResolver.ZeroParameter.selector);
        new OptimisticResolver(
            MarketFactory(address(0)),
            registry,
            sealer,
            address(this),
            token,
            BOND,
            BOND / 5,
            LIVENESS,
            7 days,
            7 days
        );
        vm.expectRevert(OptimisticResolver.ZeroParameter.selector);
        new OptimisticResolver(
            factory,
            ThresholdRegistry(address(0)),
            sealer,
            address(this),
            token,
            BOND,
            BOND / 5,
            LIVENESS,
            7 days,
            7 days
        );
        vm.expectRevert(OptimisticResolver.ZeroParameter.selector);
        new OptimisticResolver(
            factory,
            registry,
            address(0),
            address(this),
            token,
            BOND,
            BOND / 5,
            LIVENESS,
            7 days,
            7 days
        );
        vm.expectRevert(OptimisticResolver.ZeroParameter.selector);
        new OptimisticResolver(
            factory,
            registry,
            sealer,
            address(this),
            IERC20(address(0)),
            BOND,
            BOND / 5,
            LIVENESS,
            7 days,
            7 days
        );
        vm.expectRevert(OptimisticResolver.ZeroParameter.selector);
        new OptimisticResolver(
            factory, registry, sealer, address(this), token, 0, 0 / 5, LIVENESS, 7 days, 7 days
        );
        vm.expectRevert(OptimisticResolver.ZeroParameter.selector);
        new OptimisticResolver(
            factory, registry, sealer, address(this), token, BOND, BOND / 5, 0, 7 days, 7 days
        );
    }

    /// @notice A figure proposed once it can be public is stored and pulls exactly the bond.
    function test_aFigureProposalIsStoredAndPullsTheBond() public {
        vm.warp(threshold.announcesAt);
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
        OptimisticResolver.Proposal memory proposal = resolver.proposalOf(eventId);
        assertEq(proposal.proposer, proposer);
        assertEq(proposal.proposedAt, vm.getBlockTimestamp());
        assertFalse(proposal.invalid);
        assertFalse(proposal.settled);
        assertEq(proposal.figure, 125);
        assertEq(proposal.decimals, 2);
        assertEq(dollar.balanceOf(address(resolver)), BOND);
        assertEq(dollar.balanceOf(proposer), 9 * BOND);
    }

    /// @notice A proposal announces the event, the proposer and the figure.
    function test_aFigureProposalEmitsFigureProposed() public {
        vm.warp(threshold.announcesAt);
        vm.expectEmit(address(resolver));
        emit OptimisticResolver.FigureProposed(eventId, proposer, 125, 2);
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
    }

    /// @notice Nothing is proposed for an event nobody sealed, or sealed by anyone but the sealer the
    ///         resolver trusts.
    function test_RevertWhen_theEventIsNotSealedByTheTrustedSealer() public {
        vm.warp(threshold.announcesAt);
        bytes32 unsealed = keccak256("never sealed");
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotSealed.selector, unsealed));
        vm.prank(proposer);
        resolver.proposeFigure(unsealed, 125, 2);

        vm.warp(1_800_000_000);
        vm.prank(makeAddr("someone else"));
        bytes32 theirs = registry.seal(threshold);
        vm.warp(threshold.announcesAt);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotSealed.selector, theirs));
        vm.prank(proposer);
        resolver.proposeFigure(theirs, 125, 2);
    }

    /// @notice No figure is proposed before it can be public.
    function test_RevertWhen_aFigureIsProposedBeforeTheAnnouncement() public {
        vm.warp(threshold.announcesAt - 1);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.TooEarly.selector, threshold.announcesAt)
        );
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
    }

    /// @notice An event takes one proposal.
    function test_RevertWhen_anEventIsProposedTwice() public {
        vm.warp(threshold.announcesAt);
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.AlreadyProposed.selector, eventId)
        );
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 120, 2);
    }

    /// @notice A figure carries at most eighteen decimals.
    function test_RevertWhen_aFigureHasMoreThanEighteenDecimals() public {
        vm.warp(threshold.announcesAt);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.DecimalsTooLarge.selector, uint8(19))
        );
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 19);
    }

    /// @notice A proposer short of the bond, by allowance or by balance, proposes nothing.
    function test_RevertWhen_theProposerIsUnderfunded() public {
        vm.warp(threshold.announcesAt);
        vm.prank(proposer);
        dollar.approve(address(resolver), BOND - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(resolver), BOND - 1, BOND
            )
        );
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);

        address poor = makeAddr("poor");
        dollar.mint(poor, BOND - 1);
        vm.prank(poor);
        dollar.approve(address(resolver), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, poor, BOND - 1, BOND
            )
        );
        vm.prank(poor);
        resolver.proposeFigure(eventId, 125, 2);

        assertEq(resolver.proposalOf(eventId).proposer, address(0));
    }

    /// @notice A bond token that delivers less than the bond is refused.
    function test_RevertWhen_lessThanTheBondArrives() public {
        vm.warp(threshold.announcesAt);
        dollar.skim();
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.BondShortfall.selector, BOND, BOND - 1)
        );
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
    }

    /// @notice Invalid is proposed only once the deadline has passed.
    function test_invalidIsProposedOnlyAfterTheDeadline() public {
        vm.warp(threshold.deadline);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.BeforeDeadline.selector, threshold.deadline)
        );
        vm.prank(proposer);
        resolver.proposeInvalid(eventId);

        vm.warp(threshold.deadline + 1);
        vm.expectEmit(address(resolver));
        emit OptimisticResolver.InvalidProposed(eventId, proposer);
        vm.prank(proposer);
        resolver.proposeInvalid(eventId);
        assertTrue(resolver.proposalOf(eventId).invalid);
        assertEq(dollar.balanceOf(address(resolver)), BOND);
    }

    /// @notice Invalid is refused, too, for an event the trusted sealer did not seal.
    function test_RevertWhen_invalidIsProposedForAnUnsealedEvent() public {
        vm.warp(threshold.deadline + 1);
        bytes32 unsealed = keccak256("never sealed");
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NotSealed.selector, unsealed));
        vm.prank(proposer);
        resolver.proposeInvalid(unsealed);
    }

    /// @notice Nothing settles while the window is open; at its close, the derived outcome is reported,
    ///         the bond is credited, and the proposer withdraws it.
    function test_anHonestProposalPaysOutAfterTheWindow() public {
        vm.warp(threshold.announcesAt);
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
        uint256 closesAt = vm.getBlockTimestamp() + LIVENESS;

        vm.warp(closesAt - 1);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.WindowOpen.selector, closesAt));
        resolver.settle(eventId);

        vm.warp(closesAt);
        vm.expectEmit(address(resolver));
        emit OptimisticResolver.ProposalSettled(eventId, Outcome.Yes);
        resolver.settle(eventId);
        assertEq(
            uint8(factory.outcomeOf(factory.condition(address(resolver), eventId))),
            uint8(Outcome.Yes)
        );
        assertTrue(resolver.proposalOf(eventId).settled);
        assertEq(resolver.owed(proposer), BOND);

        vm.expectEmit(address(resolver));
        emit OptimisticResolver.Withdrawn(proposer, BOND);
        vm.prank(proposer);
        resolver.withdraw();
        assertEq(resolver.owed(proposer), 0);
        assertEq(dollar.balanceOf(proposer), 10 * BOND);
        assertEq(dollar.balanceOf(address(resolver)), 0);
    }

    /// @notice A settled event settles once; an event with no proposal does not settle; nothing is
    ///         withdrawn when nothing is owed.
    function test_RevertWhen_settlingTwiceOrWithoutAProposalOrWithdrawingNothing() public {
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.NoProposal.selector, eventId));
        resolver.settle(eventId);

        _proposeAndSettle(125, 2);
        vm.expectRevert(abi.encodeWithSelector(OptimisticResolver.AlreadySettled.selector, eventId));
        resolver.settle(eventId);

        vm.expectRevert(OptimisticResolver.NothingOwed.selector);
        vm.prank(holder);
        resolver.withdraw();
    }

    /// @notice Settlement reports the outcome even while the bond token refuses every transfer; only
    ///         the withdrawal waits.
    function test_settlementDoesNotWaitOnTheBondToken() public {
        vm.warp(threshold.announcesAt);
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
        dollar.stop();
        vm.warp(vm.getBlockTimestamp() + LIVENESS);
        resolver.settle(eventId);
        assertEq(
            uint8(factory.outcomeOf(factory.condition(address(resolver), eventId))),
            uint8(Outcome.Yes)
        );

        vm.expectRevert("stopped");
        vm.prank(proposer);
        resolver.withdraw();
        dollar.resume();
        vm.prank(proposer);
        resolver.withdraw();
        assertEq(dollar.balanceOf(proposer), 10 * BOND);
    }

    /// @notice The outcome is yes exactly when the figure is greater than the threshold, compared
    ///         exactly whatever the decimals on either side, and invalid when proposed invalid.
    function test_theOutcomeTable() public {
        assertEq(uint8(_outcomeOf(124, 2)), uint8(Outcome.Yes), "above");
        assertEq(uint8(_outcomeOf(123, 2)), uint8(Outcome.No), "equal");
        assertEq(uint8(_outcomeOf(122, 2)), uint8(Outcome.No), "below");
        assertEq(uint8(_outcomeOf(1231, 3)), uint8(Outcome.Yes), "above, more decimals");
        assertEq(uint8(_outcomeOf(1230, 3)), uint8(Outcome.No), "equal, more decimals");
        assertEq(uint8(_outcomeOf(12, 1)), uint8(Outcome.No), "below, fewer decimals");
        assertEq(uint8(_outcomeOf(13, 1)), uint8(Outcome.Yes), "above, fewer decimals");
        assertEq(uint8(_outcomeOf(-1, 0)), uint8(Outcome.No), "negative");
    }

    /// @notice Against a negative threshold of -1.23, -1 is above it and -1.231 below, on both sides of
    ///         the decimals: exactly where rounding toward zero instead of down would answer wrongly.
    function test_aNegativeThresholdComparesExactly() public {
        ThresholdRegistry.Threshold memory negative = threshold;
        negative.value = -123;
        vm.prank(sealer);
        bytes32 id = registry.seal(negative);
        assertEq(
            uint8(_settledOutcome(id, negative.announcesAt, -1, 0)),
            uint8(Outcome.Yes),
            "-1 > -1.23"
        );
        assertEq(
            uint8(_settledOutcome(id, negative.announcesAt, -1231, 3)),
            uint8(Outcome.No),
            "-1.231 < -1.23"
        );
    }

    /// @notice The outcome a figure for an event settles into, leaving no trace.
    /// @param id The event.
    /// @param announcesAt When its figure may be proposed.
    /// @param figure The figure.
    /// @param decimals Its decimals.
    /// @return outcome The reported outcome.
    function _settledOutcome(bytes32 id, uint64 announcesAt, int256 figure, uint8 decimals)
        internal
        returns (Outcome outcome)
    {
        uint256 snapshot = vm.snapshotState();
        vm.warp(announcesAt);
        vm.prank(proposer);
        resolver.proposeFigure(id, figure, decimals);
        vm.warp(vm.getBlockTimestamp() + LIVENESS);
        resolver.settle(id);
        outcome = factory.outcomeOf(factory.condition(address(resolver), id));
        vm.revertToState(snapshot);
    }

    /// @notice An invalid proposal settles invalid.
    function test_anInvalidProposalSettlesInvalid() public {
        vm.warp(threshold.deadline + 1);
        vm.prank(proposer);
        resolver.proposeInvalid(eventId);
        vm.warp(vm.getBlockTimestamp() + LIVENESS);
        resolver.settle(eventId);
        assertEq(
            uint8(factory.outcomeOf(factory.condition(address(resolver), eventId))),
            uint8(Outcome.Invalid)
        );
    }

    /// @notice A market over the event redeems at the outcome settlement reports.
    function test_aMarketRedeemsAtTheSettledOutcome() public {
        bytes32 id = factory.createMarket(
            IERC20(address(new TestStock())),
            IERC20(address(dollar)),
            eventId,
            address(resolver),
            type(uint256).max,
            type(uint256).max
        );
        (, PositionVault vault) = factory.markets(id);
        dollar.mint(holder, 100e6);
        vm.startPrank(holder);
        dollar.approve(address(vault), 100e6);
        vault.splitPosition(100e6);
        vm.stopPrank();

        _proposeAndSettle(125, 2);
        vm.prank(holder);
        vault.redeemPositions(100e6, 100e6);
        assertEq(dollar.balanceOf(holder), 100e6);
    }

    /// @notice Proposes a figure at the announcement and settles it at the window's close.
    /// @param figure The figure.
    /// @param decimals Its decimals.
    function _proposeAndSettle(int256 figure, uint8 decimals) internal {
        vm.warp(threshold.announcesAt);
        vm.prank(proposer);
        resolver.proposeFigure(eventId, figure, decimals);
        vm.warp(vm.getBlockTimestamp() + LIVENESS);
        resolver.settle(eventId);
    }

    /// @notice The outcome a figure settles into, each on a fresh resolver.
    /// @param figure The figure.
    /// @param decimals Its decimals.
    /// @return The reported outcome.
    function _outcomeOf(int256 figure, uint8 decimals) internal returns (Outcome) {
        uint256 snapshot = vm.snapshotState();
        _proposeAndSettle(figure, decimals);
        Outcome outcome = factory.outcomeOf(factory.condition(address(resolver), eventId));
        vm.revertToState(snapshot);
        return outcome;
    }
}
