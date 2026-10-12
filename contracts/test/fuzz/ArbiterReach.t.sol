// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {Outcome} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {TestCollateral} from "../unit/PositionVault.t.sol";

/// @title ResolverStates
/// @notice Builds an event in every state it can be in, for the tests that probe each state.
/// @dev Abstract and declared in a test file: shared test infrastructure, not a first-party contract
///      the protocol's gates have to account for.
abstract contract ResolverStates is Test {
    uint256 internal constant BOND = 500e6;
    uint256 internal constant BURN = 100e6;
    uint256 internal constant LIVENESS = 2 hours;
    uint256 internal constant STATES = 15;

    /// @notice States an event can be in, in the order built.
    uint256 internal constant UNSEALED = 0;
    uint256 internal constant NO_PROPOSAL = 1;
    uint256 internal constant ROUND_ZERO_LIVE = 2;
    uint256 internal constant ROUND_ZERO_CLOSED = 3;
    uint256 internal constant SETTLED_ROUND_ZERO = 4;
    uint256 internal constant RESET = 5;
    uint256 internal constant ROUND_ONE_LIVE = 6;
    uint256 internal constant SETTLED_ROUND_ONE = 7;
    uint256 internal constant OUTCOME_RULED = 8;
    uint256 internal constant CONTEST_RULED = 9;
    uint256 internal constant PENDING = 10;
    uint256 internal constant ROUND_ONE_CLOSED = 11;
    uint256 internal constant INVALID_PROPOSED = 12;
    uint256 internal constant EXPIRED = 13;
    uint256 internal constant RELEASED = 14;

    address internal sealer = makeAddr("sealer");
    address internal arbiter = makeAddr("arbiter");
    address internal stranger = makeAddr("stranger");
    address internal proposer = makeAddr("proposer");
    address internal disputer = makeAddr("disputer");

    ThresholdRegistry internal registry;
    MarketFactory internal factory;
    TestCollateral internal dollar;
    OptimisticResolver internal resolver;
    ThresholdRegistry.Threshold internal threshold;

    /// @notice The system, with the arbiter and a stranger funded alike, so that no difference
    ///         between them comes from their balances.
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
            7 days,
            7 days
        );
        address[4] memory funded = [arbiter, stranger, proposer, disputer];
        for (uint256 i = 0; i < funded.length; i++) {
            dollar.mint(funded[i], 100 * BOND);
            vm.prank(funded[i]);
            dollar.approve(address(resolver), type(uint256).max);
        }
        threshold = ThresholdRegistry.Threshold({
            value: 123,
            decimals: 2,
            announcesAt: uint64(vm.getBlockTimestamp() + 1 days),
            deadline: uint64(vm.getBlockTimestamp() + 9 days),
            terms: "earnings per share, diluted, as first published"
        });
    }

    /// @notice Builds an event in a state.
    /// @param state Which.
    /// @return id The event.
    function _build(uint256 state) internal returns (bytes32 id) {
        if (state == UNSEALED) {
            vm.warp(threshold.announcesAt);
            return keccak256("never sealed");
        }
        id = _seal();
        if (state == NO_PROPOSAL) return id;
        if (state == INVALID_PROPOSED) {
            vm.warp(uint256(threshold.deadline) + 1);
            vm.prank(proposer);
            resolver.proposeInvalid(id);
            return id;
        }
        if (state == EXPIRED) {
            vm.warp(resolver.expiresAt(id) + 1);
            resolver.expire(id);
            return id;
        }
        if (state == ROUND_ZERO_LIVE) return _propose(id);
        if (state == ROUND_ZERO_CLOSED) {
            _propose(id);
            vm.warp(vm.getBlockTimestamp() + LIVENESS);
            return id;
        }
        if (state == SETTLED_ROUND_ZERO) {
            _propose(id);
            vm.warp(vm.getBlockTimestamp() + LIVENESS);
            resolver.settle(id);
            return id;
        }
        _proposeAndDispute(id);
        if (state == RESET) return id;
        if (state == RELEASED) {
            vm.warp(resolver.contestTimeout(id));
            resolver.release(id);
            return id;
        }
        _propose(id);
        if (state == ROUND_ONE_LIVE) return id;
        if (state == ROUND_ONE_CLOSED) {
            vm.warp(vm.getBlockTimestamp() + LIVENESS);
            return id;
        }
        if (state == SETTLED_ROUND_ONE) {
            vm.warp(vm.getBlockTimestamp() + LIVENESS);
            resolver.settle(id);
            return id;
        }
        vm.prank(disputer);
        resolver.dispute(id);
        if (state == PENDING) return id;
        vm.prank(arbiter);
        resolver.ruleFigure(id, 125, 2, false, "the source published 1.25");
        if (state == CONTEST_RULED) {
            vm.prank(arbiter);
            resolver.ruleContest(id, true, "the first proposal was right");
        }
    }

    /// @notice Seals a fresh event and moves to its announcement.
    /// @return id The event.
    function _seal() internal returns (bytes32 id) {
        vm.prank(sealer);
        id = registry.seal(threshold);
        vm.warp(threshold.announcesAt);
    }

    /// @notice Proposes a figure.
    /// @param id The event.
    /// @return The event.
    function _propose(bytes32 id) internal returns (bytes32) {
        vm.prank(proposer);
        resolver.proposeFigure(id, 120, 2);
        return id;
    }

    /// @notice Proposes a figure and disputes it.
    /// @param id The event.
    function _proposeAndDispute(bytes32 id) internal {
        _propose(id);
        vm.prank(disputer);
        resolver.dispute(id);
    }

    /// @notice An event's outcome at the factory, under this resolver.
    /// @param id The event.
    /// @return The outcome.
    function _outcomeOf(bytes32 id) internal view returns (Outcome) {
        return factory.outcomeOf(factory.condition(address(resolver), id));
    }
}

/// @title ArbiterReachTest
/// @notice The arbiter can settle a deadlock and touches nothing outside an unresolved dispute: in
///         every function anyone may call it is anyone; it rules an event's outcome only while the
///         event is pending arbitration, and a contest's bonds only while that contest is disputed
///         and unruled; and no ruling reaches the market of an event that is not pending
///         arbitration. Every state an event can be in is built and probed.
contract ArbiterReachTest is ResolverStates {
    /// @notice In every function anyone may call, from every state, the arbiter gets exactly what a
    ///         stranger gets: the same success, the same return or revert data.
    /// @param stateSeed Chooses the event's state.
    /// @param functionSeed Chooses the function.
    /// @param figure A figure to propose.
    /// @param decimals Its decimals.
    function testFuzz_theArbiterIsAnyoneInEveryOpenFunction(
        uint256 stateSeed,
        uint256 functionSeed,
        int256 figure,
        uint8 decimals
    ) public {
        bytes32 id = _build(stateSeed % STATES);
        vm.warp(vm.getBlockTimestamp() + (functionSeed >> 8) % 10 days);
        bytes memory data = _openCall(functionSeed % 7, id, figure, decimals);

        uint256 snapshot = vm.snapshotState();
        vm.prank(arbiter);
        (bool arbiterSucceeded, bytes memory arbiterResult) = address(resolver).call(data);
        vm.revertToState(snapshot);
        vm.prank(stranger);
        (bool strangerSucceeded, bytes memory strangerResult) = address(resolver).call(data);

        assertEq(
            arbiterSucceeded, strangerSucceeded, "the arbiter and a stranger got different results"
        );
        if (!arbiterSucceeded) {
            assertEq(
                arbiterResult, strangerResult, "the arbiter and a stranger were refused differently"
            );
        }
    }

    /// @notice Outside arbitration, ruling an outcome is refused and writes nothing, anywhere.
    /// @param stateSeed Chooses the event's state; never pending arbitration.
    /// @param figure A figure to rule.
    /// @param decimals Its decimals.
    /// @param proposerWasRight Whether to rule the proposer right.
    /// @param invalid Whether to rule invalid instead, after the deadline.
    function testFuzz_outcomeRulingsReachNothingOutsideArbitration(
        uint256 stateSeed,
        int256 figure,
        uint8 decimals,
        bool proposerWasRight,
        bool invalid
    ) public {
        uint256 state = stateSeed % STATES;
        // The one state where an outcome ruling is the arbiter's to make; probed separately below.
        if (state == PENDING) state = NO_PROPOSAL;
        bytes32 id = _build(state);
        decimals = uint8(bound(decimals, 0, 18));
        if (invalid) vm.warp(uint256(threshold.deadline) + 1);

        vm.startStateDiffRecording();
        vm.prank(arbiter);
        (bool succeeded, bytes memory result) = invalid
            ? address(resolver)
                .call(
                    abi.encodeCall(
                        OptimisticResolver.ruleInvalid, (id, proposerWasRight, "a ruling")
                    )
                )
            : address(resolver)
                .call(
                    abi.encodeCall(
                        OptimisticResolver.ruleFigure,
                        (id, figure, decimals, proposerWasRight, "a ruling")
                    )
                );
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        assertFalse(succeeded, "an outcome was ruled outside arbitration");
        assertEq(result, abi.encodeWithSelector(OptimisticResolver.NotPending.selector, id));
        assertEq(_writers(accesses).length, 0, "a refused ruling wrote state");
    }

    /// @notice A contest's bonds are ruled only while it is disputed and unruled, and then only the
    ///         resolver's own records change: no market's outcome, no token balance.
    /// @param stateSeed Chooses the event's state.
    /// @param proposerWasRight Whether to rule the proposer right.
    function testFuzz_aContestIsRuledOnlyWhileDisputedAndUnruled(
        uint256 stateSeed,
        bool proposerWasRight
    ) public {
        uint256 state = stateSeed % STATES;
        bytes32 id = _build(state);
        Outcome before = _outcomeOf(id);

        vm.startStateDiffRecording();
        vm.prank(arbiter);
        (bool succeeded, bytes memory result) = address(resolver)
            .call(
                abi.encodeCall(OptimisticResolver.ruleContest, (id, proposerWasRight, "a ruling"))
            );
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        bool disputedAndUnruled = (state >= RESET && state <= OUTCOME_RULED) || state == PENDING
            || state == ROUND_ONE_CLOSED;
        assertEq(
            succeeded, disputedAndUnruled, "a contest was ruled, or refused, against its state"
        );
        address[] memory writers = _writers(accesses);
        if (!succeeded) {
            bytes4 expected = state == CONTEST_RULED || state == RELEASED
                ? OptimisticResolver.AlreadyRuled.selector
                : OptimisticResolver.NotDisputed.selector;
            assertEq(result, abi.encodeWithSelector(expected, id));
            assertEq(writers.length, 0, "a refused ruling wrote state");
            return;
        }
        assertEq(writers.length, 1, "a contest ruling wrote outside the resolver");
        assertEq(writers[0], address(resolver), "a contest ruling wrote outside the resolver");
        assertEq(uint8(_outcomeOf(id)), uint8(before), "a contest ruling moved a market's outcome");
    }

    /// @notice A deadlock — an event disputed twice — is settled by the arbiter's ruling.
    /// @param figure The figure ruled.
    /// @param decimals Its decimals.
    function testFuzz_theArbiterSettlesADeadlock(int256 figure, uint8 decimals) public {
        bytes32 id = _seal();
        _proposeAndDispute(id);
        _proposeAndDispute(id);
        decimals = uint8(bound(decimals, 0, 18));
        vm.prank(arbiter);
        resolver.ruleFigure(id, figure, decimals, false, "the source published this figure");
        assertTrue(_outcomeOf(id) != Outcome.Unresolved, "the deadlock was not settled");
        assertFalse(resolver.eventOf(id).pendingArbitration);
    }

    /// @notice A call to one of the functions anyone may call.
    /// @param which Which.
    /// @param id The event.
    /// @param figure A figure.
    /// @param decimals Its decimals.
    /// @return The calldata.
    function _openCall(uint256 which, bytes32 id, int256 figure, uint8 decimals)
        internal
        pure
        returns (bytes memory)
    {
        if (which == 0) {
            return abi.encodeCall(OptimisticResolver.proposeFigure, (id, figure, decimals));
        }
        if (which == 1) return abi.encodeCall(OptimisticResolver.proposeInvalid, (id));
        if (which == 2) return abi.encodeCall(OptimisticResolver.dispute, (id));
        if (which == 3) return abi.encodeCall(OptimisticResolver.settle, (id));
        if (which == 4) return abi.encodeCall(OptimisticResolver.expire, (id));
        if (which == 5) return abi.encodeCall(OptimisticResolver.release, (id));
        return abi.encodeCall(OptimisticResolver.withdraw, ());
    }

    /// @notice Every account whose storage a recorded call changed, ignoring reverted writes.
    /// @param accesses What was recorded.
    /// @return writers The accounts, each once.
    function _writers(Vm.AccountAccess[] memory accesses)
        internal
        pure
        returns (address[] memory writers)
    {
        address[] memory found = new address[](accesses.length);
        uint256 count;
        for (uint256 i = 0; i < accesses.length; i++) {
            Vm.StorageAccess[] memory storageAccesses = accesses[i].storageAccesses;
            for (uint256 j = 0; j < storageAccesses.length; j++) {
                Vm.StorageAccess memory access = storageAccesses[j];
                if (!access.isWrite || access.reverted || access.previousValue == access.newValue) {
                    continue;
                }
                bool seen;
                for (uint256 k = 0; k < count; k++) {
                    if (found[k] == access.account) seen = true;
                }
                if (!seen) found[count++] = access.account;
            }
        }
        writers = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            writers[i] = found[i];
        }
    }
}
