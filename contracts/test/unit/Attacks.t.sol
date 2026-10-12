// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {SkimmingDollar} from "./OptimisticResolver.t.sol";
import {TestCollateral} from "./PositionVault.t.sol";

/// @notice What a holder registered with the hooked dollar is told.
interface ITokenHolder {
    /// @notice Called before the holder's tokens leave it.
    function tokensToSend() external;

    /// @notice Called after tokens arrive at the holder.
    function tokensReceived() external;
}

/// @title HookedDollar
/// @notice A dollar that, as tokens with holder hooks do, calls a registered holder before its tokens
///         leave and after tokens arrive. For tests only: the resolver assumes a plain bond token, and
///         these tests show it holds even when that assumption is broken.
contract HookedDollar is TestCollateral {
    mapping(address holder => bool) internal registered;

    /// @notice Registers the caller for hooks.
    function register() external {
        registered[msg.sender] = true;
    }

    /// @notice Moves value, calling the sender's hook first and the recipient's after.
    /// @param from The sender.
    /// @param to The recipient.
    /// @param value How much.
    function _update(address from, address to, uint256 value) internal override {
        if (registered[from]) ITokenHolder(from).tokensToSend();
        super._update(from, to, value);
        if (registered[to]) ITokenHolder(to).tokensReceived();
    }
}

/// @title HookAttacker
/// @notice A bond holder that calls back into the resolver from its token hooks, once per arming, and
///         records what the call back returned.
contract HookAttacker is ITokenHolder {
    OptimisticResolver internal immutable RESOLVER;
    bytes internal pending;
    /// @notice Whether the last call back succeeded.
    bool public succeeded;
    /// @notice What the last call back returned or reverted with.
    bytes public result;

    /// @notice Registers with the dollar and approves the resolver.
    /// @param resolver The resolver.
    /// @param dollar The hooked dollar.
    constructor(OptimisticResolver resolver, HookedDollar dollar) {
        RESOLVER = resolver;
        dollar.register();
        dollar.approve(address(resolver), type(uint256).max);
    }

    /// @notice Arms one call back, made from the next hook.
    /// @param data The call.
    function arm(bytes calldata data) external {
        pending = data;
    }

    /// @notice Calls the resolver as this holder.
    /// @param data The call.
    function act(bytes calldata data) external {
        (bool ok, bytes memory returned) = address(RESOLVER).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(returned, 32), mload(returned))
            }
        }
    }

    /// @inheritdoc ITokenHolder
    function tokensToSend() external {
        _callBack();
    }

    /// @inheritdoc ITokenHolder
    function tokensReceived() external {
        _callBack();
    }

    /// @notice Makes the armed call back once, keeping its result.
    function _callBack() internal {
        if (pending.length == 0) return;
        bytes memory data = pending;
        delete pending;
        (succeeded, result) = address(RESOLVER).call(data);
    }
}

/// @title ExpiryAttacker
/// @notice Disputes a late proposal and expires the event in one transaction, hoping to force it
///         invalid before anyone can propose again.
contract ExpiryAttacker {
    /// @notice Approves the resolver for its bond.
    /// @param resolver The resolver.
    /// @param dollar The bond token.
    constructor(OptimisticResolver resolver, IERC20 dollar) {
        dollar.approve(address(resolver), type(uint256).max);
    }

    /// @notice Disputes the first round and expires the event, atomically.
    /// @param resolver The resolver.
    /// @param eventId The event.
    function attack(OptimisticResolver resolver, bytes32 eventId) external {
        resolver.dispute(eventId, 0);
        resolver.expire(eventId);
    }
}

/// @title AttacksTest
/// @notice Every attack on resolution, as an attacker would run it, shown to fail.
/// @dev Attacks shown to fail elsewhere, cited rather than repeated:
///      sealing another's threshold first — `ThresholdRegistryTest.test_anotherSealerIsAnotherEvent`;
///      resolving an event the trusted sealer did not seal —
///      `OptimisticResolverTest.test_RevertWhen_theEventIsNotSealedByTheTrustedSealer`;
///      proposing invalid before the deadline — `OptimisticResolverTest.test_invalidIsProposedOnlyAfterTheDeadline`;
///      proposing after expiry — `TimeoutsTest.test_noProposalIsAcceptedAfterExpiry`;
///      ruling a proposer right for another answer — `DisputesTest.test_RevertWhen_theProposerIsRuledRightForAnotherFigure`;
///      settling, ruling, releasing or withdrawing twice — `OptimisticResolverTest.test_RevertWhen_settlingTwiceOrWithoutAProposalOrWithdrawingNothing`,
///      `DisputesTest.test_theRoundZeroContestIsRuledOnce`, `DisputesTest.test_RevertWhen_rulingAnEventNotPending`,
///      `TimeoutsTest.test_anUnruledFirstContestIsReleased`;
///      a token delivering less than the bond — `OptimisticResolverTest.test_RevertWhen_lessThanTheBondArrives`;
///      draining one event's bonds through another's — `ResolutionInvariantsTest.invariant_eachAccountIsOwedItsCredits`;
///      reporting for an event from another address — `RedemptionTest.test_reportLandsUnderTheSendersConditionOnly`;
///      a market over the same event with another resolver — `RedemptionTest.test_aDifferentResolverIsADifferentMarket`;
///      every timing edge — the resolver reads only the block's time, and each edge is one comparison against one
///      public view used by both sides, pinned at the second before and the second itself by
///      `DisputesTest.test_aDisputeIsAcceptedUntilTheWindowCloses`, `TimeoutsTest.test_anEventNobodyResolvesExpiresInvalid`,
///      `TimeoutsTest.test_theArbiterRulesUntilItsTimeout`, `TimeoutsTest.test_anUnruledFirstContestIsReleased`;
///      sealing at the announcement — `ThresholdRegistryTest.test_RevertWhen_sealingAtOrAfterTheAnnouncement`;
///      reporting mid-split through a collateral's hook — `RedemptionTest.test_RevertWhen_outcomeIsReportedDuringTheSplitsPull`;
///      figure extremes — `ComparisonTableTest.test_extremesMatchExactArithmetic`;
///      settlement and rulings waiting on the bond token — `OptimisticResolverTest.test_settlementDoesNotWaitOnTheBondToken`,
///      `DisputesTest.test_aRulingDoesNotWaitOnTheBondToken`.
contract AttacksTest is Test {
    uint256 internal constant BOND = 500e6;
    uint256 internal constant BURN = 100e6;
    uint256 internal constant LIVENESS = 2 hours;
    uint256 internal constant EXPIRY = 7 days;
    uint256 internal constant ARBITER_TIMEOUT = 7 days;

    address internal sealer = makeAddr("sealer");
    address internal arbiter = makeAddr("arbiter");
    address internal attacker = makeAddr("attacker");
    address internal accomplice = makeAddr("accomplice");
    address internal honest = makeAddr("honest");
    address internal other = makeAddr("another honest party");

    ThresholdRegistry internal registry;
    MarketFactory internal factory;
    SkimmingDollar internal dollar;
    OptimisticResolver internal resolver;
    ThresholdRegistry.Threshold internal threshold;
    bytes32 internal eventId;

    /// @notice A sealed event with threshold 1.23, at its announcement, and funded parties.
    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new ThresholdRegistry();
        factory = new MarketFactory();
        dollar = new SkimmingDollar();
        resolver = _resolver(IERC20(address(dollar)));
        eventId = _seal("the event");
        address[4] memory funded = [attacker, accomplice, honest, other];
        for (uint256 i = 0; i < funded.length; i++) {
            dollar.mint(funded[i], 10 * BOND);
            vm.prank(funded[i]);
            dollar.approve(address(resolver), type(uint256).max);
        }
        vm.warp(threshold.announcesAt);
    }

    /// @notice A dispute meant for the first round, executing after a reset and a second proposal,
    ///         would dispute the second — a correct one — and cost its sender the bond. It is refused:
    ///         a dispute names the round it disputes.
    function test_RevertWhen_aDisputeMeantForTheFirstRoundLandsOnTheSecond() public {
        vm.prank(attacker);
        resolver.proposeFigure(eventId, 100, 2);
        vm.prank(honest);
        resolver.dispute(eventId, 0);
        vm.prank(other);
        resolver.proposeFigure(eventId, 125, 2);

        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.WrongRound.selector, eventId, uint8(1))
        );
        vm.prank(other);
        resolver.dispute(eventId, 0);
    }

    /// @notice A wrong proposer front-runs an honest disputer with its own dispute and proposes the
    ///         correct figure, so the honest dispute would land on it. The honest dispute is refused,
    ///         its sender keeps its bond, and the attacker's best case is losing the burn.
    function test_aSelfDisputeFrontRunLeavesTheVictimsBondUntouched() public {
        vm.prank(attacker);
        resolver.proposeFigure(eventId, 100, 2);
        vm.prank(accomplice);
        resolver.dispute(eventId, 0);
        vm.prank(attacker);
        resolver.proposeFigure(eventId, 125, 2);

        uint256 victimBefore = dollar.balanceOf(honest);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.WrongRound.selector, eventId, uint8(1))
        );
        vm.prank(honest);
        resolver.dispute(eventId, 0);
        assertEq(dollar.balanceOf(honest), victimBefore, "the victim lost something");

        vm.prank(arbiter);
        resolver.ruleContest(
            eventId, false, "the first proposal was 1.00; the source published 1.25"
        );
        vm.warp(vm.getBlockTimestamp() + LIVENESS);
        resolver.settle(eventId);
        int256 net = int256(resolver.owed(attacker) + resolver.owed(accomplice)) - int256(3 * BOND);
        assertEq(net, -int256(BURN), "the attacker's best case is not losing the burn");
    }

    /// @notice Right after a reset, an attacker squats the second round with a wrong figure to force
    ///         arbitration. The arbiter rules the true figure and the squatter's bond goes to the
    ///         disputer, less the burn. (Were the arbiter silent, both bonds would go back.)
    function test_squattingTheSecondRoundWithAWrongFigureLosesItsBond() public {
        vm.prank(other);
        resolver.proposeFigure(eventId, 100, 2);
        vm.prank(honest);
        resolver.dispute(eventId, 0);
        vm.prank(attacker);
        resolver.proposeFigure(eventId, 90, 2);
        vm.prank(honest);
        resolver.dispute(eventId, 1);

        vm.prank(arbiter);
        resolver.ruleFigure(eventId, 125, 2, false, "the source published 1.25");
        assertEq(resolver.owed(attacker), 0, "the squatter kept its bond");
        assertEq(resolver.owed(honest), 2 * BOND - BURN, "the disputer was not paid");
    }

    /// @notice A figure guessed before publication is wrong whatever its value: disputed, and ruled
    ///         wrong by the arbiter, the guesser loses its bond — even when the guess matches the
    ///         figure later published.
    function test_aFigureGuessedBeforePublicationLosesItsBond() public {
        vm.prank(attacker);
        resolver.proposeFigure(eventId, 125, 2);
        vm.prank(honest);
        resolver.dispute(eventId, 0);
        vm.prank(arbiter);
        resolver.ruleContest(eventId, false, "proposed before the source published anything");
        assertEq(resolver.owed(attacker), 0, "the guesser kept its bond");
        assertEq(resolver.owed(honest), 2 * BOND - BURN, "the disputer was not paid");
    }

    /// @notice A late dispute and an expiry in one transaction, to force invalid before anyone can
    ///         propose again: the reset restarts the expiry clock, so the expiry is refused.
    function test_RevertWhen_aLateDisputeAndAnExpiryShareATransaction() public {
        ExpiryAttacker contractAttacker = new ExpiryAttacker(resolver, IERC20(address(dollar)));
        dollar.mint(address(contractAttacker), BOND);
        vm.warp(resolver.expiresAt(eventId));
        vm.prank(honest);
        resolver.proposeFigure(eventId, 125, 2);
        uint256 proposedAt = vm.getBlockTimestamp();

        vm.warp(proposedAt + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptimisticResolver.NotExpired.selector, proposedAt + LIVENESS + EXPIRY
            )
        );
        contractAttacker.attack(resolver, eventId);
    }

    /// @notice Disputing one's own proposal to stall costs exactly the burn when the arbiter rules,
    ///         and nothing when it never does — the release returns both bonds.
    function test_aSelfDisputeCostsTheBurnWhenRuledAndNothingWhenReleased() public {
        bytes32 released = _sealAtAnnouncement("released");
        _selfDispute(eventId);
        _selfDispute(released);

        vm.prank(arbiter);
        resolver.ruleContest(eventId, false, "a dispute of one's own proposal");
        vm.warp(resolver.contestTimeout(released));
        resolver.release(released);

        int256 net = int256(resolver.owed(attacker) + resolver.owed(accomplice)) - int256(4 * BOND);
        assertEq(net, -int256(BURN), "a self-dispute did not cost exactly the burn, once");
    }

    /// @notice Re-proposing the same event from the bond token's hook, mid-pull, is refused.
    function test_RevertWhen_aProposalIsReenteredFromTheBondTokensHook() public {
        (OptimisticResolver hooked, HookAttacker holder, bytes32 id) = _hooked();
        holder.arm(abi.encodeCall(OptimisticResolver.proposeFigure, (id, 130, 2)));
        holder.act(abi.encodeCall(OptimisticResolver.proposeFigure, (id, 125, 2)));
        assertFalse(holder.succeeded(), "a second proposal entered mid-pull");
        assertEq(
            holder.result(), abi.encodeWithSelector(OptimisticResolver.AlreadyProposed.selector, id)
        );
        assertEq(hooked.proposalOf(id).figure, 125);
    }

    /// @notice A dispute re-entered from the hook mid-pull lands a second bond inside the first pull,
    ///         and the exact-equality pull refuses the whole proposal.
    function test_RevertWhen_aDisputeIsReenteredFromTheBondTokensHook() public {
        (, HookAttacker holder, bytes32 id) = _hooked();
        holder.arm(abi.encodeCall(OptimisticResolver.dispute, (id, 0)));
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.BondShortfall.selector, BOND, 2 * BOND)
        );
        holder.act(abi.encodeCall(OptimisticResolver.proposeFigure, (id, 125, 2)));
    }

    /// @notice A withdrawal re-entered from the payout hook finds nothing owed: the credit is zeroed
    ///         before the transfer, so it is paid once.
    function test_aWithdrawalReenteredFromThePayoutHookIsPaidOnce() public {
        (OptimisticResolver hooked, HookAttacker holder, bytes32 id) = _hooked();
        holder.act(abi.encodeCall(OptimisticResolver.proposeFigure, (id, 125, 2)));
        vm.warp(vm.getBlockTimestamp() + LIVENESS);
        hooked.settle(id);

        HookedDollar token = HookedDollar(address(hooked.BOND_TOKEN()));
        uint256 before = token.balanceOf(address(holder));
        holder.arm(abi.encodeCall(OptimisticResolver.withdraw, ()));
        holder.act(abi.encodeCall(OptimisticResolver.withdraw, ()));
        assertEq(holder.result(), abi.encodeWithSelector(OptimisticResolver.NothingOwed.selector));
        assertEq(token.balanceOf(address(holder)) - before, BOND, "a credit was paid twice");
        assertEq(token.balanceOf(address(hooked)), 0);
    }

    /// @notice A stopped bond token blocks no exit: an event nobody resolved expires, an event the
    ///         arbiter left expires, and an unruled first contest is released.
    function test_aStoppedBondTokenBlocksNoExit() public {
        bytes32 silent = _sealAtAnnouncement("silent");
        for (uint256 round = 0; round < 2; round++) {
            vm.prank(attacker);
            resolver.proposeFigure(silent, 125, 2);
            vm.prank(honest);
            resolver.dispute(silent, uint8(round));
        }
        dollar.stop();

        vm.warp(resolver.outcomeTimeout(silent));
        resolver.expire(silent);
        resolver.release(silent);
        vm.warp(resolver.expiresAt(eventId) + 1);
        resolver.expire(eventId);
    }

    /// @notice A resolver over a bond token, trusting this test's sealer and arbiter.
    /// @param token The bond token.
    /// @return The resolver.
    function _resolver(IERC20 token) internal returns (OptimisticResolver) {
        return new OptimisticResolver(
            factory, registry, sealer, arbiter, token, BOND, BURN, LIVENESS, EXPIRY, ARBITER_TIMEOUT
        );
    }

    /// @notice Seals a threshold of 1.23 a day out, as the trusted sealer.
    /// @param terms Its terms, which make each event distinct.
    /// @return id The event.
    function _seal(bytes memory terms) internal returns (bytes32 id) {
        threshold = ThresholdRegistry.Threshold({
            value: 123,
            decimals: 2,
            announcesAt: uint64(vm.getBlockTimestamp() + 1 days),
            deadline: uint64(vm.getBlockTimestamp() + 9 days),
            terms: terms
        });
        vm.prank(sealer);
        id = registry.seal(threshold);
    }

    /// @notice Seals another event whose announcement is now, without moving the clock.
    /// @param terms Its terms.
    /// @return id The event.
    function _sealAtAnnouncement(bytes memory terms) internal returns (bytes32 id) {
        uint256 now_ = vm.getBlockTimestamp();
        vm.warp(now_ - 1 days);
        id = _seal(terms);
        vm.warp(now_);
    }

    /// @notice The attacker proposes and its accomplice disputes the proposal.
    /// @param id The event.
    function _selfDispute(bytes32 id) internal {
        vm.prank(attacker);
        resolver.proposeFigure(id, 125, 2);
        vm.prank(accomplice);
        resolver.dispute(id, 0);
    }

    /// @notice A resolver whose bond token calls holders back, a holder that calls back, and an event
    ///         at its announcement.
    /// @return hooked The resolver.
    /// @return holder The holder.
    /// @return id The event.
    function _hooked()
        internal
        returns (OptimisticResolver hooked, HookAttacker holder, bytes32 id)
    {
        HookedDollar token = new HookedDollar();
        hooked = _resolver(IERC20(address(token)));
        holder = new HookAttacker(hooked, token);
        token.mint(address(holder), 10 * BOND);
        id = _sealAtAnnouncement("hooked");
    }
}
