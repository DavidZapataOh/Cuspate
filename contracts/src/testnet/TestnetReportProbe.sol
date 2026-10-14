// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title TestnetReportProbe
/// @notice A receiver for a Chainlink CRE workflow's reports that only records them: who delivered
///         each one and the workflow's id, owner, name and report id as the forwarder packed them.
///         A receiver that trusts one workflow is fixed to its owner and name at construction, so
///         those are read here, from a real delivery, before that receiver is created.
/// @dev It holds nothing and acts on nothing, so it accepts every caller and every length: a probe
///      that refused a delivery would hide exactly what it exists to show.
contract TestnetReportProbe is IERC165, TestnetOnly {
    /// @notice The length of the metadata a forwarder passes: id, name, owner and report id.
    uint256 internal constant METADATA_LENGTH = 64;

    /// @notice Emitted for every delivery. The fields are zero when the metadata is not the
    ///         forwarder's length; the metadata is always recorded whole.
    /// @param forwarder Who delivered it.
    /// @param workflowId The workflow's id.
    /// @param workflowOwner The workflow's owner.
    /// @param workflowName The workflow's name, as the forwarder encodes it.
    /// @param reportId The report's id.
    /// @param metadata The metadata, whole.
    /// @param report The report, whole.
    event ReportReceived(
        address indexed forwarder,
        bytes32 indexed workflowId,
        address indexed workflowOwner,
        bytes10 workflowName,
        bytes2 reportId,
        bytes metadata,
        bytes report
    );

    /// @notice Fixes the owner, which runs nothing here, and refuses any chain but a test one.
    /// @param owner_ The owner.
    constructor(address owner_) TestnetOnly(owner_) {}

    /// @notice Records a delivery.
    /// @param metadata The workflow's id, name and owner, and the report id, packed: 32, 10, 20 and 2
    ///        bytes.
    /// @param report The report the workflow produced.
    /// @custom:access anyone
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (metadata.length != METADATA_LENGTH) {
            emit ReportReceived(
                msg.sender, bytes32(0), address(0), bytes10(0), bytes2(0), metadata, report
            );
            return;
        }
        emit ReportReceived(
            msg.sender,
            bytes32(metadata[0:32]),
            address(bytes20(metadata[42:62])),
            bytes10(metadata[32:42]),
            bytes2(metadata[62:64]),
            metadata,
            report
        );
    }

    /// @notice Answers the interface check a forwarder makes before it delivers.
    /// @param interfaceId The interface asked about.
    /// @return Whether it is the receiver's or ERC-165's.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == this.onReport.selector || interfaceId == type(IERC165).interfaceId;
    }
}
