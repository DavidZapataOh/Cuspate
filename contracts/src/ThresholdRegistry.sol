// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title ThresholdRegistry
/// @notice Seals, before its figure can be public, the number an event is about, and keeps it
///         unchanged forever. The event resolves yes if and only if the figure, as first published by
///         the source its terms name and compared exactly — never rounded or truncated, sign
///         included — is greater than `value / 10**decimals`.
/// @dev The event id commits to the whole threshold and to its sealer, so there is nothing to alter:
///      any other field, or any other sealer, is another event. Nothing writes a sealed entry twice
///      and nothing deletes one; the contract has no owner, no proxy and no self-destruct.
contract ThresholdRegistry {
    /// @notice What an event is about.
    /// @param value The threshold, scaled by `10**decimals`; signed.
    /// @param decimals How many decimals `value` carries; at most eighteen.
    /// @param announcesAt The earliest instant the figure may become public, in Unix seconds. Nothing
    ///        is sealed at or after it.
    /// @param deadline The last instant, in Unix seconds, at which the figure may be published by the
    ///        primary source or the fallback source. It bounds publication, not the proposal.
    /// @param terms In UTF-8: the metric and its period; basic or diluted, and the accounting basis;
    ///        the currency or unit; the primary source; the fallback source and the UTC instant it
    ///        applies from; that the figure counts as first published, restatements ignored; and any
    ///        reference market. Times written here are informational: `announcesAt` and `deadline`
    ///        govern.
    struct Threshold {
        int256 value;
        uint8 decimals;
        uint64 announcesAt;
        uint64 deadline;
        bytes terms;
    }

    /// @notice A sealed threshold and who sealed it, at which block.
    /// @param sealer Who sealed it.
    /// @param sealBlock The block it was sealed in.
    /// @param threshold What was sealed.
    struct Seal {
        address sealer;
        uint256 sealBlock;
        Threshold threshold;
    }

    /// @notice The most decimals a threshold may carry. Far below the point where `10**decimals`
    ///         would overflow, and so any rescaling of the threshold, would leave the event
    ///         unresolvable.
    uint8 public constant MAX_DECIMALS = 18;

    mapping(bytes32 eventId => Seal) internal seals;

    /// @notice Thrown when an event is sealed again.
    /// @param eventId The event.
    error AlreadySealed(bytes32 eventId);

    /// @notice Thrown when sealing at or after the earliest instant the figure may be public.
    /// @param announcesAt That instant.
    error TooLate(uint64 announcesAt);

    /// @notice Thrown when the deadline does not come after the announcement.
    error DeadlineBeforeAnnouncement();

    /// @notice Thrown when the threshold carries more decimals than any figure needs.
    /// @param decimals What it carries.
    error DecimalsTooLarge(uint8 decimals);

    /// @notice Thrown when a threshold has no terms.
    error EmptyTerms();

    /// @notice Emitted when a threshold is sealed.
    /// @param eventId The event it defines.
    /// @param sealer Who sealed it.
    /// @param sealBlock The block it was sealed in.
    /// @param threshold What was sealed, terms included.
    event ThresholdSealed(
        bytes32 indexed eventId, address indexed sealer, uint256 sealBlock, Threshold threshold
    );

    /// @notice Seals a threshold, once, before its figure can be public.
    /// @param threshold What the event is about.
    /// @return eventId The event, as markets name it.
    /// @custom:access anyone
    function seal(Threshold calldata threshold) external returns (bytes32 eventId) {
        // A rule about a public instant hours or days ahead, not about order within a block, so the
        // seconds a block carries are the right clock.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= threshold.announcesAt) {
            revert TooLate(threshold.announcesAt);
        }
        if (threshold.deadline <= threshold.announcesAt) {
            revert DeadlineBeforeAnnouncement();
        }
        if (threshold.decimals > MAX_DECIMALS) {
            revert DecimalsTooLarge(threshold.decimals);
        }
        if (threshold.terms.length == 0) {
            revert EmptyTerms();
        }
        eventId = eventIdOf(msg.sender, threshold);
        if (seals[eventId].sealer != address(0)) {
            revert AlreadySealed(eventId);
        }
        emit ThresholdSealed(eventId, msg.sender, block.number, threshold);
        Seal storage entry = seals[eventId];
        entry.sealer = msg.sender;
        entry.sealBlock = block.number;
        entry.threshold = threshold;
    }

    /// @notice The event a sealer's threshold defines.
    /// @param sealer Who seals it.
    /// @param threshold What it is about.
    /// @return The event id.
    function eventIdOf(address sealer, Threshold calldata threshold) public pure returns (bytes32) {
        return keccak256(abi.encode(sealer, threshold));
    }

    /// @notice Everything sealed for an event, terms included.
    /// @param eventId The event.
    /// @return sealer Who sealed it; zero if nobody has.
    /// @return sealBlock The block it was sealed in.
    /// @return threshold What was sealed.
    function sealOf(bytes32 eventId)
        external
        view
        returns (address sealer, uint256 sealBlock, Threshold memory threshold)
    {
        Seal storage entry = seals[eventId];
        return (entry.sealer, entry.sealBlock, entry.threshold);
    }

    /// @notice The fixed fields sealed for an event, without the terms, so reading them costs the
    ///         same whatever the terms' length. What a resolver reads.
    /// @param eventId The event.
    /// @return sealer Who sealed it; zero if nobody has.
    /// @return sealBlock The block it was sealed in.
    /// @return value The threshold, scaled by `10**decimals`.
    /// @return decimals The decimals of `value`.
    /// @return announcesAt The earliest instant the figure may become public.
    /// @return deadline The last instant the figure may be published.
    function thresholdOf(bytes32 eventId)
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
        Seal storage entry = seals[eventId];
        Threshold storage threshold = entry.threshold;
        return (
            entry.sealer,
            entry.sealBlock,
            threshold.value,
            threshold.decimals,
            threshold.announcesAt,
            threshold.deadline
        );
    }
}
