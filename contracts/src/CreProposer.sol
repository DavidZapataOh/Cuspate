// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {OptimisticResolver} from "./OptimisticResolver.sol";

/// @title IReceiver
/// @notice What a Chainlink CRE forwarder calls to deliver a workflow's report: the interface its
///         forwarders check, through ERC-165, before they deliver. Declared here from its published
///         signature.
interface IReceiver is IERC165 {
    /// @notice Delivers a report.
    /// @param metadata The workflow's id, name and owner, and the report id, packed: 32, 10, 20 and 2
    ///        bytes.
    /// @param report The report the workflow produced.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title CreProposer
/// @notice Proposes to the resolver the figure a Chainlink CRE workflow read, posting the bond from
///         its own balance. A report counts only from the one forwarder this receiver trusts and only
///         from the one workflow, identified by its owner and its name: never by its id, which changes
///         with every update of the workflow.
/// @dev An additional proposer, never the only one: it calls the resolver as anyone may, under the
///      same rules. It proposes figures only. A workflow cannot see the fallback source, so it cannot
///      know that no source has the figure; an event nobody resolves expires invalid on its own.
///      Which forwarder it trusts decides everything: a forwarder that does not verify signatures
///      lets anyone deliver any report, so a receiver over one holds no bond worth taking.
contract CreProposer is IReceiver {
    using SafeERC20 for IERC20;

    /// @notice The length of the metadata a forwarder passes.
    uint256 internal constant METADATA_LENGTH = 64;

    /// @notice The only forwarder whose reports count.
    address public immutable FORWARDER;
    /// @notice Where figures are proposed.
    OptimisticResolver public immutable RESOLVER;
    /// @notice The owner of the only workflow whose reports count.
    address public immutable WORKFLOW_OWNER;
    /// @notice The name of the only workflow whose reports count, as the forwarder's metadata
    ///         carries it.
    bytes10 public immutable WORKFLOW_NAME;
    /// @notice Where settled bonds, and anything recovered, are sent.
    address public immutable TREASURY;
    /// @notice The token bonds are posted in: the resolver's, which never changes.
    IERC20 public immutable BOND_TOKEN;
    /// @notice The bond every proposal posts: the resolver's, which never changes.
    uint256 public immutable BOND;

    /// @notice Thrown when a constructor parameter is zero.
    error ZeroParameter();
    /// @notice Thrown when a report does not come through the trusted forwarder.
    /// @param caller Who delivered it.
    error NotForwarder(address caller);
    /// @notice Thrown when the metadata is not the length a forwarder passes.
    /// @param length Its length.
    error MalformedMetadata(uint256 length);
    /// @notice Thrown when a report comes from another workflow.
    /// @param owner The workflow's owner.
    /// @param name The workflow's name.
    error UnexpectedWorkflow(address owner, bytes10 name);
    /// @notice Thrown when the open round follows a disputed proposal of this receiver's own.
    /// @param eventId The event.
    error OwnProposalDisputed(bytes32 eventId);
    /// @notice Thrown when someone other than the treasury recovers a balance.
    /// @param caller Who tried.
    error NotTreasury(address caller);

    /// @notice Emitted when settled bonds are sent to the treasury.
    /// @param amount How much.
    event Swept(uint256 amount);
    /// @notice Emitted when the treasury recovers a balance.
    /// @param token The token.
    /// @param amount How much.
    event Recovered(IERC20 indexed token, uint256 amount);

    /// @notice Fixes what this receiver trusts and where its bonds go.
    /// @param forwarder The only forwarder whose reports count.
    /// @param resolver Where figures are proposed.
    /// @param workflowOwner The owner of the only workflow whose reports count.
    /// @param workflowName Its name, as the forwarder's metadata carries it.
    /// @param treasury Where settled bonds, and anything recovered, are sent.
    constructor(
        address forwarder,
        OptimisticResolver resolver,
        address workflowOwner,
        bytes10 workflowName,
        address treasury
    ) {
        if (
            forwarder == address(0) || address(resolver) == address(0)
                || workflowOwner == address(0) || workflowName == bytes10(0)
                || treasury == address(0)
        ) {
            revert ZeroParameter();
        }
        FORWARDER = forwarder;
        RESOLVER = resolver;
        WORKFLOW_OWNER = workflowOwner;
        WORKFLOW_NAME = workflowName;
        TREASURY = treasury;
        BOND_TOKEN = resolver.BOND_TOKEN();
        BOND = resolver.BOND();
    }

    /// @notice Proposes the figure a report carries, posting the bond. The resolver's own rules
    ///         decide whether it may: a report it refuses reverts, and costs nothing.
    /// @param metadata The workflow's id, name and owner, and the report id, as the forwarder packs
    ///        them.
    /// @param report The event, the figure scaled by `10**decimals`, and the decimals, ABI-encoded.
    /// @custom:access forwarder
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != FORWARDER) {
            revert NotForwarder(msg.sender);
        }
        if (metadata.length != METADATA_LENGTH) {
            revert MalformedMetadata(metadata.length);
        }
        bytes10 name = bytes10(metadata[32:42]);
        address owner = address(bytes20(metadata[42:62]));
        if (owner != WORKFLOW_OWNER || name != WORKFLOW_NAME) {
            revert UnexpectedWorkflow(owner, name);
        }
        (bytes32 eventId, int256 figure, uint8 decimals) =
            abi.decode(report, (bytes32, int256, uint8));
        // A disputed proposal of this receiver's is not answered by the next run of the same
        // workflow: a second proposal on the same word would take the event to the arbiter unopposed.
        OptimisticResolver.EventState memory state = RESOLVER.eventOf(eventId);
        if (state.round == 1 && state.rounds[0].proposer == address(this)) {
            revert OwnProposalDisputed(eventId);
        }
        BOND_TOKEN.forceApprove(address(RESOLVER), BOND);
        RESOLVER.proposeFigure(eventId, figure, decimals);
    }

    /// @notice Sends every bond the resolver has credited to this receiver to the treasury, and only
    ///         those: the balance kept for future bonds stays.
    /// @return amount How much was sent; zero when nothing was owed.
    /// @custom:access anyone
    function sweep() external returns (uint256 amount) {
        // Exactly what the resolver pays: it transfers what it owes, and its bond token cannot keep a
        // fee, since the resolver accepts a bond only when exactly the bond arrives.
        amount = RESOLVER.owed(address(this));
        if (amount == 0) {
            return 0;
        }
        emit Swept(amount);
        RESOLVER.withdraw();
        BOND_TOKEN.safeTransfer(TREASURY, amount);
    }

    /// @notice Sends a balance this receiver holds to the treasury: the bonds kept for proposals, when
    ///         the workflow stops, or anything sent here by mistake.
    /// @param token The token.
    /// @param amount How much.
    /// @custom:access treasury
    function recover(IERC20 token, uint256 amount) external {
        if (msg.sender != TREASURY) {
            revert NotTreasury(msg.sender);
        }
        emit Recovered(token, amount);
        token.safeTransfer(TREASURY, amount);
    }

    /// @notice Whether this contract implements an interface: the receiver's and ERC-165's.
    /// @param interfaceId The interface.
    /// @return True for those two.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
