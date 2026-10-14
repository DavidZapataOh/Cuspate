// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IReceiver} from "../../src/CreProposer.sol";
import {TestnetOnly} from "../../src/testnet/TestnetOnly.sol";
import {TestnetReportProbe} from "../../src/testnet/TestnetReportProbe.sol";

/// @title TestnetReportProbeTest
/// @notice The receiver that only records what a workflow's forwarder delivers, so the workflow's
///         owner and name are read from a real delivery before a receiver that trusts them exists.
contract TestnetReportProbeTest is Test {
    address internal constant OWNER = address(0xA11CE);
    address internal constant FORWARDER = address(0xF0);
    bytes32 internal constant WORKFLOW_ID = keccak256("workflow");
    bytes10 internal constant NAME = bytes10("1a2b3c4d5e");
    address internal constant WORKFLOW_OWNER = 0x040e0FCf01BC56Abe785C56D5b1cBe40f3AdFeE4;
    bytes2 internal constant REPORT_ID = 0x0001;

    TestnetReportProbe internal probe;

    /// @notice The probe, on the test network's chain id.
    function setUp() public {
        vm.chainId(10_143);
        probe = new TestnetReportProbe(OWNER);
    }

    /// @notice A forwarder's delivery is recorded field by field, from whoever delivered it.
    function test_aDeliveryIsRecordedFieldByField() public {
        bytes memory metadata = abi.encodePacked(WORKFLOW_ID, NAME, WORKFLOW_OWNER, REPORT_ID);
        bytes memory report = abi.encode(bytes32(uint256(7)), int256(123), uint8(2));
        vm.expectEmit(address(probe));
        emit TestnetReportProbe.ReportReceived(
            FORWARDER, WORKFLOW_ID, WORKFLOW_OWNER, NAME, REPORT_ID, metadata, report
        );
        vm.prank(FORWARDER);
        probe.onReport(metadata, report);
    }

    /// @notice Metadata of any other length is still recorded, whole, with no field read from it.
    function test_malformedMetadataIsRecordedWhole() public {
        bytes memory metadata = hex"0102";
        vm.expectEmit(address(probe));
        emit TestnetReportProbe.ReportReceived(
            FORWARDER, bytes32(0), address(0), bytes10(0), bytes2(0), metadata, ""
        );
        vm.prank(FORWARDER);
        probe.onReport(metadata, "");
    }

    /// @notice It answers the interface check a forwarder makes before delivering, and no other.
    function test_answersTheForwardersInterfaceCheck() public view {
        assertTrue(probe.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(probe.supportsInterface(type(IERC165).interfaceId));
        assertFalse(probe.supportsInterface(0xffffffff));
    }

    /// @notice Like every test contract, it cannot be created on the production chain.
    function test_refusesTheProductionChain() public {
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.NotATestChain.selector, 143));
        new TestnetReportProbe(OWNER);
    }
}
