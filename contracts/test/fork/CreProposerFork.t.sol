// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {CreProposer} from "../../src/CreProposer.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";

/// @notice A Chainlink CRE forwarder, as far as this suite uses it.
interface IForwarder {
    /// @notice Emitted once a report has been delivered, or delivery failed.
    /// @param receiver The receiver.
    /// @param workflowExecutionId The workflow execution.
    /// @param reportId The report id.
    /// @param result Whether the receiver accepted it.
    event ReportProcessed(
        address indexed receiver,
        bytes32 indexed workflowExecutionId,
        bytes2 indexed reportId,
        bool result
    );

    /// @notice Delivers a signed report to a receiver.
    /// @param receiver The receiver.
    /// @param rawReport The report with its metadata.
    /// @param reportContext The context the signatures cover.
    /// @param signatures The signatures.
    function report(
        address receiver,
        bytes calldata rawReport,
        bytes calldata reportContext,
        bytes[] calldata signatures
    ) external;

    /// @notice Calls a receiver with a report already validated.
    /// @param transmissionId The transmission.
    /// @param transmitter Who transmitted it.
    /// @param receiver The receiver.
    /// @param metadata The report's metadata.
    /// @param validatedReport The report.
    /// @return Whether the receiver accepted it.
    function route(
        bytes32 transmissionId,
        address transmitter,
        address receiver,
        bytes calldata metadata,
        bytes calldata validatedReport
    ) external returns (bool);
}

/// @title CreProposerForkTest
/// @notice The CRE receiver over the forwarders deployed on the production chain at a pinned block:
///         the simulation forwarder delivers the workflow's report and the receiver proposes with
///         its bond in the real dollar; a report from another workflow is refused; and the
///         simulation forwarder, unlike the production one, delivers anything anyone routes.
contract CreProposerForkTest is Test {
    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;
    uint256 internal constant BOND = 500e6;
    /// @notice The gas the workflow asks the forwarder to deliver a report with.
    uint256 internal constant REPORT_GAS_LIMIT = 500_000;
    bytes10 internal constant NAME = "a1b2c3d4e5";
    bytes32 internal constant EXECUTION = keccak256("an execution");
    bytes2 internal constant REPORT_ID = 0x0001;

    address internal sealer = makeAddr("sealer");
    address internal workflowOwner = makeAddr("workflow owner");
    address internal treasury = makeAddr("treasury");

    IERC20 internal dollar;
    IForwarder internal simulation;
    IForwarder internal production;
    OptimisticResolver internal resolver;
    CreProposer internal receiver;
    bytes32 internal eventId;

    /// @notice A sealed event whose figure can be public, a resolver bonded in the real dollar, and a
    ///         receiver over the simulation forwarder holding two bonds.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);
        assertEq(block.chainid, PRODUCTION_CHAIN, "not on a fork of the production chain");
        assertEq(block.number, pinned, "not at the pinned block");
        dollar = IERC20(AddressBook.thirdParty("dollar", 0));
        simulation = IForwarder(AddressBook.thirdParty("creSimulationForwarder", 0));
        production = IForwarder(AddressBook.thirdParty("creForwarder", 0));

        ThresholdRegistry registry = new ThresholdRegistry();
        resolver = new OptimisticResolver(
            new MarketFactory(),
            registry,
            sealer,
            address(this),
            dollar,
            BOND,
            BOND / 5,
            2 hours,
            7 days,
            7 days
        );
        uint64 announcesAt = uint64(block.timestamp + 1 days);
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
        receiver = new CreProposer(address(simulation), resolver, workflowOwner, NAME, treasury);
        deal(address(dollar), address(receiver), 2 * BOND);
        vm.warp(announcesAt);
    }

    /// @notice The metadata a forwarder passes a receiver: workflow id, name, owner, report id.
    /// @param owner The workflow owner.
    /// @return The 64 bytes.
    function _metadata(address owner) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256("a workflow id"), NAME, owner, REPORT_ID);
    }

    /// @notice A raw report as a forwarder receives it: version, execution id, timestamp, DON id,
    ///         DON configuration version, then the metadata the receiver sees, then the report.
    /// @param owner The workflow owner.
    /// @param figure The figure, scaled by a hundred.
    /// @return The raw report.
    function _rawReport(address owner, int256 figure) internal view returns (bytes memory) {
        return bytes.concat(
            abi.encodePacked(uint8(1), EXECUTION, uint32(block.timestamp), uint32(1), uint32(1)),
            _metadata(owner),
            abi.encode(eventId, figure, uint8(2))
        );
    }

    /// @notice The simulation forwarder delivers the workflow's report, the receiver proposes with
    ///         its bond in the real dollar, and the delivery fits the gas the workflow asks for.
    function test_simulationForwarder_deliversTheWorkflowsReport() public {
        bytes memory raw = _rawReport(workflowOwner, 3342);
        uint256 before = dollar.balanceOf(address(resolver));

        vm.expectEmit(address(simulation));
        emit IForwarder.ReportProcessed(address(receiver), EXECUTION, REPORT_ID, true);
        uint256 gasBefore = gasleft();
        simulation.report(address(receiver), raw, "", new bytes[](0));
        uint256 used = gasBefore - gasleft();

        OptimisticResolver.Proposal memory proposal = resolver.proposalOf(eventId);
        assertEq(proposal.proposer, address(receiver));
        assertEq(proposal.figure, 3342);
        assertEq(proposal.decimals, 2);
        assertEq(dollar.balanceOf(address(resolver)) - before, BOND);
        assertEq(dollar.balanceOf(address(receiver)), BOND);
        assertLt(used, REPORT_GAS_LIMIT, "the delivery needs more gas than the workflow asks for");
    }

    /// @notice A report from another workflow is refused: the forwarder records the failure, and
    ///         nothing moves.
    function test_simulationForwarder_reportFromAnotherWorkflowIsRefused() public {
        bytes memory raw = _rawReport(makeAddr("another owner"), 3342);

        vm.expectEmit(address(simulation));
        emit IForwarder.ReportProcessed(address(receiver), EXECUTION, REPORT_ID, false);
        simulation.report(address(receiver), raw, "", new bytes[](0));

        assertEq(resolver.proposalOf(eventId).proposer, address(0));
        assertEq(dollar.balanceOf(address(receiver)), 2 * BOND);
    }

    /// @notice A forgery routed directly, naming another owner, is refused.
    function test_simulationForwarder_routedForgeryOfAnotherOwnerIsRefused() public {
        bytes memory metadata = _metadata(makeAddr("another owner"));
        bytes memory report = abi.encode(eventId, int256(9999), uint8(2));
        vm.prank(makeAddr("stranger"));
        assertFalse(
            simulation.route(
                keccak256("forged"), address(this), address(receiver), metadata, report
            )
        );
        assertEq(resolver.proposalOf(eventId).proposer, address(0));
    }

    /// @notice The simulation forwarder delivers anything anyone routes with the expected owner and
    ///         name.
    function test_simulationForwarder_isAPublicDoor() public {
        // Anyone may call the simulation forwarder's route with the expected owner and name, which
        // every report discloses, and the receiver cannot tell: a receiver over it is for simulation
        // and must never hold a bond worth taking or propose to a resolver that settles markets.
        bytes memory metadata = _metadata(workflowOwner);
        bytes memory report = abi.encode(eventId, int256(9999), uint8(2));
        vm.prank(makeAddr("stranger"));
        assertTrue(
            simulation.route(
                keccak256("forged"), address(this), address(receiver), metadata, report
            )
        );
        assertEq(resolver.proposalOf(eventId).figure, 9999);
    }

    /// @notice The production forwarder refuses a report without the network's signatures.
    function test_productionForwarder_refusesAnUnsignedReport() public {
        CreProposer guarded =
            new CreProposer(address(production), resolver, workflowOwner, NAME, treasury);
        deal(address(dollar), address(guarded), BOND);
        bytes memory raw = _rawReport(workflowOwner, 3342);
        vm.expectRevert();
        production.report(address(guarded), raw, "", new bytes[](0));
        assertEq(resolver.proposalOf(eventId).proposer, address(0));
    }
}
