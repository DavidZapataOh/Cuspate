// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";

/// @title SealsHandler
/// @notice Seals thresholds of every terms length by three sealers while time and blocks advance at
///         random, and attempts repeat seals and late seals on purpose, requiring their exact
///         refusals. Records every seal it saw accepted, under the id it computes itself, and every
///         id it attempted too late.
/// @dev Declared in the campaign's test file: a handler is test infrastructure, and a file of its
///      own would make it a first-party contract the protocol's gates have to account for.
contract SealsHandler is CommonBase, StdCheats, StdUtils {
    /// @notice The registry under test.
    ThresholdRegistry public immutable REGISTRY;

    /// @notice The instant every announcement time is measured from.
    uint64 public immutable ORIGIN;

    /// @notice A seal as the handler saw it accepted.
    struct Recorded {
        address sealer;
        uint256 sealBlock;
        ThresholdRegistry.Threshold threshold;
    }

    /// @notice Five hundred bytes of terms, cut to each length the campaign uses.
    bytes internal constant TERMS =
        "The figure as first published by the primary source, compared exactly with the threshold. The figure as first published by the primary source, compared exactly with the threshold. The figure as first published by the primary source, compared exactly with the threshold. The figure as first published by the primary source, compared exactly with the threshold. The figure as first published by the primary source, compared exactly with the threshold. The figure as first published by the primary sourc";

    address[3] internal sealers = [address(0x5001), address(0x5002), address(0x5003)];
    uint256[5] internal lengths = [uint256(1), 31, 32, 33, 500];

    /// @notice Every event the handler saw sealed, in order.
    bytes32[] public sealedIds;
    /// @notice Every event the handler attempted at or after its announcement.
    bytes32[] public lateIds;
    mapping(bytes32 eventId => Recorded) internal recorded;
    mapping(bytes32 eventId => bool) internal late;

    /// @notice How many seals were accepted.
    uint256 public seals;
    /// @notice How many repeat seals were refused.
    uint256 public repeatsRefused;

    /// @notice Takes the registry, and the current time as the origin.
    /// @param registry The registry.
    constructor(ThresholdRegistry registry) {
        REGISTRY = registry;
        ORIGIN = uint64(block.timestamp);
    }

    /// @notice How many events were sealed.
    /// @return The count.
    function sealedCount() external view returns (uint256) {
        return sealedIds.length;
    }

    /// @notice How many events were attempted too late.
    /// @return The count.
    function lateCount() external view returns (uint256) {
        return lateIds.length;
    }

    /// @notice A seal as the handler saw it accepted.
    /// @param eventId The event.
    /// @return The record.
    function recordOf(bytes32 eventId) external view returns (Recorded memory) {
        return recorded[eventId];
    }

    /// @notice A seal's fixed fields as the handler saw it accepted, without copying its terms.
    /// @param eventId The event.
    /// @return sealer Who sealed it.
    /// @return sealBlock Its block.
    /// @return value Its value.
    /// @return decimals Its decimals.
    /// @return announcesAt Its announcement.
    /// @return deadline Its deadline.
    function fixedOf(bytes32 eventId)
        external
        view
        returns (
            address sealer,
            uint256 sealBlock,
            int256 value,
            uint8 decimals,
            uint64 announcesAt,
            uint64 deadline
        )
    {
        Recorded storage made = recorded[eventId];
        return (
            made.sealer,
            made.sealBlock,
            made.threshold.value,
            made.threshold.decimals,
            made.threshold.announcesAt,
            made.threshold.deadline
        );
    }

    /// @notice Seals a threshold drawn from the seeds: before its announcement it must be accepted
    ///         once and refused as a repeat after; at or after it, refused as too late.
    /// @param sealerSeed Chooses the sealer.
    /// @param shapeSeed Chooses the value, decimals, deadline and terms.
    /// @param aheadSeed Chooses how far after the origin the announcement is.
    function seal(uint256 sealerSeed, uint256 shapeSeed, uint256 aheadSeed) external {
        address sealer = sealers[sealerSeed % 3];
        ThresholdRegistry.Threshold memory threshold = _threshold(shapeSeed, aheadSeed);
        bytes32 id = keccak256(abi.encode(sealer, threshold));

        vm.prank(sealer);
        try REGISTRY.seal(threshold) returns (bytes32) {
            if (block.timestamp >= threshold.announcesAt) {
                // Accepted although late: recorded as late, so the property sees it.
                _late(id);
            } else if (recorded[id].sealer == address(0)) {
                recorded[id] = Recorded(sealer, block.number, threshold);
                sealedIds.push(id);
                seals++;
            }
            // Accepted as a repeat: the original record stands, so the property sees any change.
        } catch (bytes memory reason) {
            bool late_ = block.timestamp >= threshold.announcesAt;
            bool repeat = recorded[id].sealer != address(0);
            bytes memory tooLate =
                abi.encodeWithSelector(ThresholdRegistry.TooLate.selector, threshold.announcesAt);
            // A repeat is matched on its selector alone: the id it carries is the registry's own,
            // and comparing it with the one computed here would turn a hashing fault into a refusal
            // mismatch instead of letting the property that names it fail. When an attempt is both a
            // repeat and late, either refusal is right: the order of the checks is not a promise.
            bool refusedAsRepeat = bytes4(reason) == ThresholdRegistry.AlreadySealed.selector;
            if (late_ && !(repeat && refusedAsRepeat)) {
                _require(reason, tooLate);
                _late(id);
            } else {
                require(refusedAsRepeat, "a seal was refused for the wrong reason");
                repeatsRefused++;
            }
        }
    }

    /// @notice Moves time forward by one or two hours, never less: the fuzzer favours edge values,
    ///         and steps of a second would leave a run that never reaches an announcement.
    /// @param secondsSeed Chooses one or two hours.
    /// @param blocksSeed How many blocks.
    function advance(uint256 secondsSeed, uint256 blocksSeed) external {
        vm.warp(block.timestamp + 1 hours * (1 + secondsSeed % 2));
        vm.roll(block.number + _bound(blocksSeed, 1, 1000));
    }

    /// @notice A threshold from the seeds. Few distinct shapes, one per terms length, so repeats
    ///         happen; announcements one or three days out, reached by steps of one or two hours, so
    ///         each run seals early and attempts late.
    /// @param shapeSeed Chooses the value, decimals, deadline and terms.
    /// @param aheadSeed Chooses the announcement.
    /// @return threshold The threshold.
    function _threshold(uint256 shapeSeed, uint256 aheadSeed)
        internal
        view
        returns (ThresholdRegistry.Threshold memory threshold)
    {
        uint256 shape = shapeSeed % 5;
        uint256 length = lengths[shape];
        bytes memory terms = TERMS;
        // Shortened in place: the length word is all that changes, and each shape has its own length.
        assembly ("memory-safe") {
            mstore(terms, length)
        }
        uint64 announcesAt = ORIGIN + uint64(1 + 2 * (aheadSeed % 2)) * 1 days;
        threshold = ThresholdRegistry.Threshold({
            value: int256(shape) * 125 - 500,
            decimals: uint8(shape % 3) * 6,
            announcesAt: announcesAt,
            deadline: announcesAt + uint64(1 + shape % 3) * 4 days,
            terms: terms
        });
    }

    /// @notice Records, once, an event attempted too late that was never sealed in time. An event
    ///         sealed in time and attempted again late is refused as late, and rightly stays sealed.
    /// @param id The event.
    function _late(bytes32 id) internal {
        if (recorded[id].sealer == address(0) && !late[id]) {
            late[id] = true;
            lateIds.push(id);
        }
    }

    /// @notice Requires a refusal to be exactly the one owed.
    /// @param reason What was returned.
    /// @param expected What is owed.
    function _require(bytes memory reason, bytes memory expected) internal pure {
        require(keccak256(reason) == keccak256(expected), "a seal was refused for the wrong reason");
    }
}

/// @title SealsInvariantsTest
/// @notice Nothing sealed is ever altered or removed, and nothing is sealed at or after its
///         announcement: every seal reads back exactly as it was made, through both reads, and every
///         event attempted too late stays unsealed.
contract SealsInvariantsTest is Test {
    ThresholdRegistry internal registry;
    SealsHandler internal handler;

    /// @notice A registry and the handler, as the only target.
    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1_000);
        registry = new ThresholdRegistry();
        handler = new SealsHandler(registry);
        targetContract(address(handler));
    }

    /// @notice Every event attempted at or after its announcement is unsealed.
    function invariant_lateSealsNeverLand() public view {
        for (uint256 i = 0; i < handler.lateCount(); i++) {
            (address sealer,,,,,) = registry.thresholdOf(handler.lateIds(i));
            assertEq(sealer, address(0), "late: a seal landed at or after its announcement");
        }
    }

    /// @notice Closes each run: every seal reads back exactly as it was made, through both reads,
    ///         terms byte for byte; and the run sealed, refused a repeat and refused a late seal.
    /// @dev Checked once per run rather than after every call. A sealed entry has no path to change
    ///      and change back, so an alteration persists to the end of the run; reading every seal
    ///      after every call cost over three times the campaign's time budget.
    function afterInvariant() public view {
        _fixedFieldsNeverChange();
        for (uint256 i = 0; i < handler.sealedCount(); i++) {
            bytes32 id = handler.sealedIds(i);
            SealsHandler.Recorded memory made = handler.recordOf(id);
            (address sealer, uint256 sealBlock, ThresholdRegistry.Threshold memory read) =
                registry.sealOf(id);
            assertEq(sealer, made.sealer, "seals: another sealer in the full read");
            assertEq(sealBlock, made.sealBlock, "seals: another block in the full read");
            assertEq(keccak256(read.terms), keccak256(made.threshold.terms), "seals: other terms");
            assertEq(
                keccak256(abi.encode(read)),
                keccak256(abi.encode(made.threshold)),
                "seals: another threshold"
            );
        }
        assertGt(handler.seals(), 0, "the campaign sealed nothing");
        assertGt(handler.repeatsRefused(), 0, "the campaign never attempted a repeat");
        assertGt(handler.lateCount(), 0, "the campaign never attempted a late seal");
    }

    /// @notice Every seal's fixed fields read back exactly as they were made: sealer, block, value,
    ///         decimals, announcement and deadline.
    function _fixedFieldsNeverChange() internal view {
        for (uint256 i = 0; i < handler.sealedCount(); i++) {
            bytes32 id = handler.sealedIds(i);
            (
                address sealer,
                uint256 sealBlock,
                int256 value,
                uint8 decimals,
                uint64 announcesAt,
                uint64 deadline
            ) = registry.thresholdOf(id);
            (
                address madeSealer,
                uint256 madeBlock,
                int256 madeValue,
                uint8 madeDecimals,
                uint64 madeAnnouncesAt,
                uint64 madeDeadline
            ) = handler.fixedOf(id);
            assertEq(sealer, madeSealer, "seals: another sealer");
            assertEq(sealBlock, madeBlock, "seals: another block");
            assertEq(value, madeValue, "seals: another value");
            assertEq(decimals, madeDecimals, "seals: other decimals");
            assertEq(announcesAt, madeAnnouncesAt, "seals: another announcement");
            assertEq(deadline, madeDeadline, "seals: another deadline");
        }
    }
}
