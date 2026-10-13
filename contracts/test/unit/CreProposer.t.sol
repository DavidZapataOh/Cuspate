// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {CreProposer, IReceiver} from "../../src/CreProposer.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {TestCollateral} from "./PositionVault.t.sol";

/// @title CreProposerTest
/// @notice A report from the trusted workflow, delivered by the trusted forwarder, becomes a bonded
///         proposal of its figure; anything else is refused, and settled bonds reach the treasury.
contract CreProposerTest is Test {
    uint256 internal constant BOND = 500e6;
    uint256 internal constant LIVENESS = 2 hours;
    bytes10 internal constant NAME = "a1b2c3d4e5";

    address internal sealer = makeAddr("sealer");
    address internal forwarder = makeAddr("forwarder");
    address internal workflowOwner = makeAddr("workflow owner");
    address internal treasury = makeAddr("treasury");
    address internal disputer = makeAddr("disputer");

    TestCollateral internal dollar;
    OptimisticResolver internal resolver;
    CreProposer internal receiver;
    bytes32 internal eventId;
    uint64 internal announcesAt;

    /// @notice A sealed event, a resolver bonded in the test dollar, and a receiver funded for two
    ///         bonds.
    function setUp() public {
        dollar = new TestCollateral();
        ThresholdRegistry registry = new ThresholdRegistry();
        resolver = new OptimisticResolver(
            new MarketFactory(),
            registry,
            sealer,
            address(this),
            dollar,
            BOND,
            BOND / 5,
            LIVENESS,
            7 days,
            7 days
        );
        announcesAt = uint64(block.timestamp + 1 days);
        vm.prank(sealer);
        eventId = registry.seal(
            ThresholdRegistry.Threshold({
                value: 3000,
                decimals: 2,
                announcesAt: announcesAt,
                deadline: announcesAt + 8 days,
                terms: "earnings per share, diluted, non-GAAP, as first published"
            })
        );
        receiver = new CreProposer(forwarder, resolver, workflowOwner, NAME, treasury);
        dollar.mint(address(receiver), 2 * BOND);
        dollar.mint(disputer, 2 * BOND);
        vm.prank(disputer);
        dollar.approve(address(resolver), type(uint256).max);
        vm.warp(announcesAt);
    }

    /// @notice The metadata the forwarder passes: the workflow's id, name and owner, and the report id.
    /// @param owner The workflow owner.
    /// @param name The workflow name.
    /// @return The 64 bytes.
    function _metadata(address owner, bytes10 name) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256("a workflow id"), name, owner, bytes2(0x0001));
    }

    /// @notice A report proposing `figure` for the event.
    /// @param figure The figure, scaled by a hundred.
    /// @return The report.
    function _report(int256 figure) internal view returns (bytes memory) {
        return abi.encode(eventId, figure, uint8(2));
    }

    /// @notice Delivers a report from the trusted workflow through the trusted forwarder.
    /// @param figure The figure, scaled by a hundred.
    function _deliver(int256 figure) internal {
        vm.prank(forwarder);
        receiver.onReport(_metadata(workflowOwner, NAME), _report(figure));
    }

    /// @notice The receiver keeps what it trusts, and copies the resolver's bond and bond token.
    function test_constructor_copiesTheResolversBond() public view {
        assertEq(address(receiver.FORWARDER()), forwarder);
        assertEq(address(receiver.RESOLVER()), address(resolver));
        assertEq(receiver.WORKFLOW_OWNER(), workflowOwner);
        assertEq(receiver.WORKFLOW_NAME(), NAME);
        assertEq(receiver.TREASURY(), treasury);
        assertEq(address(receiver.BOND_TOKEN()), address(dollar));
        assertEq(receiver.BOND(), BOND);
    }

    /// @notice Every parameter is required.
    function test_RevertWhen_constructorIsGivenAZeroParameter() public {
        vm.expectRevert(CreProposer.ZeroParameter.selector);
        new CreProposer(address(0), resolver, workflowOwner, NAME, treasury);
        vm.expectRevert(CreProposer.ZeroParameter.selector);
        new CreProposer(forwarder, OptimisticResolver(address(0)), workflowOwner, NAME, treasury);
        vm.expectRevert(CreProposer.ZeroParameter.selector);
        new CreProposer(forwarder, resolver, address(0), NAME, treasury);
        vm.expectRevert(CreProposer.ZeroParameter.selector);
        new CreProposer(forwarder, resolver, workflowOwner, bytes10(0), treasury);
        vm.expectRevert(CreProposer.ZeroParameter.selector);
        new CreProposer(forwarder, resolver, workflowOwner, NAME, address(0));
    }

    /// @notice It declares the receiver interface and ERC-165, by their published ids, and nothing
    ///         else.
    function test_supportsInterface_declaresTheReceiverAndIntrospection() public view {
        assertEq(type(IReceiver).interfaceId, bytes4(0x805f2132));
        assertEq(type(IERC165).interfaceId, bytes4(0x01ffc9a7));
        assertTrue(receiver.supportsInterface(0x805f2132));
        assertTrue(receiver.supportsInterface(0x01ffc9a7));
        assertFalse(receiver.supportsInterface(0xffffffff));
        assertFalse(receiver.supportsInterface(0x12345678));
    }

    /// @notice A report from the workflow, through the forwarder, proposes its figure with a bond,
    ///         and leaves no approval behind.
    function test_onReport_proposesTheFigureWithItsBond() public {
        vm.expectEmit(address(resolver));
        emit OptimisticResolver.FigureProposed(eventId, address(receiver), 3342, 2);
        _deliver(3342);

        OptimisticResolver.Proposal memory proposal = resolver.proposalOf(eventId);
        assertEq(proposal.proposer, address(receiver));
        assertEq(proposal.figure, 3342);
        assertEq(proposal.decimals, 2);
        assertFalse(proposal.invalid);
        assertEq(dollar.balanceOf(address(resolver)), BOND);
        assertEq(dollar.balanceOf(address(receiver)), BOND);
        assertEq(dollar.allowance(address(receiver), address(resolver)), 0, "approval left over");
    }

    /// @notice A loss is proposed as reported, signed.
    function test_onReport_proposesANegativeFigure() public {
        _deliver(-131);
        assertEq(resolver.proposalOf(eventId).figure, -131);
    }

    /// @notice A report not delivered by the forwarder is refused.
    function test_RevertWhen_onReportCallerIsNotTheForwarder() public {
        bytes memory metadata = _metadata(workflowOwner, NAME);
        bytes memory report = _report(3342);
        vm.expectRevert(abi.encodeWithSelector(CreProposer.NotForwarder.selector, address(this)));
        receiver.onReport(metadata, report);
    }

    /// @notice A report from a workflow of another owner is refused, whatever its name.
    function test_RevertWhen_onReportComesFromAnotherWorkflowOwner() public {
        address stranger = makeAddr("another owner");
        bytes memory metadata = _metadata(stranger, NAME);
        bytes memory report = _report(3342);
        vm.expectRevert(
            abi.encodeWithSelector(CreProposer.UnexpectedWorkflow.selector, stranger, NAME)
        );
        vm.prank(forwarder);
        receiver.onReport(metadata, report);
    }

    /// @notice A report from another workflow of the same owner is refused.
    function test_RevertWhen_onReportComesFromAnotherWorkflowName() public {
        bytes10 other = "f0f0f0f0f0";
        bytes memory metadata = _metadata(workflowOwner, other);
        bytes memory report = _report(3342);
        vm.expectRevert(
            abi.encodeWithSelector(CreProposer.UnexpectedWorkflow.selector, workflowOwner, other)
        );
        vm.prank(forwarder);
        receiver.onReport(metadata, report);
    }

    /// @notice Metadata of any length but the forwarder's is refused.
    function test_RevertWhen_onReportMetadataIsNotTheForwardersLength() public {
        bytes memory full = _metadata(workflowOwner, NAME);
        bytes memory short = new bytes(63);
        bytes memory long = bytes.concat(full, hex"00");
        bytes memory report = _report(3342);
        vm.startPrank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CreProposer.MalformedMetadata.selector, uint256(63)));
        receiver.onReport(short, report);
        vm.expectRevert(abi.encodeWithSelector(CreProposer.MalformedMetadata.selector, uint256(65)));
        receiver.onReport(long, report);
        vm.stopPrank();
    }

    /// @notice The workflow does not answer the dispute of its own proposal.
    function test_RevertWhen_onReportFollowsItsOwnDisputedProposal() public {
        // A disputed proposal from the workflow is not answered by the workflow's next run: the
        // second round's proposal would send the event to the arbiter on the workflow's word alone.
        _deliver(3342);
        vm.prank(disputer);
        resolver.dispute(eventId, 0);
        bytes memory metadata = _metadata(workflowOwner, NAME);
        bytes memory report = _report(3342);
        vm.expectRevert(abi.encodeWithSelector(CreProposer.OwnProposalDisputed.selector, eventId));
        vm.prank(forwarder);
        receiver.onReport(metadata, report);
    }

    /// @notice The workflow may propose in the second round when the disputed proposal was someone
    ///         else's.
    function test_onReport_answersAnotherProposersDisputedProposal() public {
        address someone = makeAddr("someone");
        dollar.mint(someone, BOND);
        vm.startPrank(someone);
        dollar.approve(address(resolver), BOND);
        resolver.proposeFigure(eventId, 9999, 2);
        vm.stopPrank();
        vm.prank(disputer);
        resolver.dispute(eventId, 0);

        _deliver(3342);
        assertEq(resolver.proposalOf(eventId).proposer, address(receiver));
        assertEq(resolver.eventOf(eventId).round, 1);
    }

    /// @notice The resolver's own rules hold: a second proposal is refused, and costs nothing.
    function test_RevertWhen_onReportFindsAProposalAlready() public {
        _deliver(3342);
        bytes memory metadata = _metadata(workflowOwner, NAME);
        bytes memory report = _report(3342);
        vm.expectRevert(
            abi.encodeWithSelector(OptimisticResolver.AlreadyProposed.selector, eventId)
        );
        vm.prank(forwarder);
        receiver.onReport(metadata, report);
        assertEq(dollar.balanceOf(address(receiver)), BOND, "a refused report cost a bond");
    }

    /// @notice A settled bond goes to the treasury; the balance kept for bonds stays.
    function test_sweep_sendsTheSettledBondToTheTreasury() public {
        _deliver(3342);
        vm.warp(block.timestamp + LIVENESS);
        resolver.settle(eventId);
        assertEq(resolver.owed(address(receiver)), BOND);

        vm.expectEmit(address(receiver));
        emit CreProposer.Swept(BOND);
        assertEq(receiver.sweep(), BOND);
        assertEq(dollar.balanceOf(treasury), BOND);
        assertEq(dollar.balanceOf(address(receiver)), BOND, "the pre-funded bond moved");
        assertEq(resolver.owed(address(receiver)), 0);
    }

    /// @notice Sweeping with nothing owed moves nothing, and does not revert.
    function test_sweep_withNothingOwedMovesNothing() public {
        assertEq(receiver.sweep(), 0);
        assertEq(dollar.balanceOf(treasury), 0);
        assertEq(dollar.balanceOf(address(receiver)), 2 * BOND);
    }

    /// @notice The treasury recovers the balance kept for bonds.
    function test_recover_returnsTheIdleBalanceToTheTreasury() public {
        vm.expectEmit(address(receiver));
        emit CreProposer.Recovered(dollar, BOND);
        vm.prank(treasury);
        receiver.recover(dollar, BOND);
        assertEq(dollar.balanceOf(treasury), BOND);
        assertEq(dollar.balanceOf(address(receiver)), BOND);
    }

    /// @notice Nobody but the treasury recovers a balance.
    function test_RevertWhen_recoverCallerIsNotTheTreasury() public {
        vm.expectRevert(abi.encodeWithSelector(CreProposer.NotTreasury.selector, address(this)));
        receiver.recover(dollar, BOND);
    }
}
