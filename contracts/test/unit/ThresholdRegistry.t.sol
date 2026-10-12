// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";

/// @title ThresholdRegistryTest
/// @notice A threshold is sealed once, before its figure can be public, under an id that commits to
///         it and to its sealer, and reads back unchanged.
contract ThresholdRegistryTest is Test {
    ThresholdRegistry internal registry;
    address internal sealer = makeAddr("sealer");
    address internal other = makeAddr("another sealer");

    /// @notice A registry, at a known time and block.
    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(100);
        registry = new ThresholdRegistry();
    }

    /// @notice The id is the hash of the sealer and the whole threshold.
    function test_eventIdIsTheHashOfTheSealerAndTheThreshold() public view {
        ThresholdRegistry.Threshold memory threshold = _threshold(32);
        assertEq(registry.eventIdOf(sealer, threshold), keccak256(abi.encode(sealer, threshold)));
    }

    /// @notice The same threshold under another sealer is another event.
    function test_anotherSealerIsAnotherEvent() public view {
        ThresholdRegistry.Threshold memory threshold = _threshold(32);
        assertNotEq(registry.eventIdOf(sealer, threshold), registry.eventIdOf(other, threshold));
    }

    /// @notice Every field is in the id: changing any one of them is another event.
    function test_everyFieldIsInTheEventId() public view {
        ThresholdRegistry.Threshold memory base = _threshold(32);
        bytes32 id = registry.eventIdOf(sealer, base);
        ThresholdRegistry.Threshold memory changed = _threshold(32);
        changed.value = base.value + 1;
        assertNotEq(registry.eventIdOf(sealer, changed), id, "value");
        changed = _threshold(32);
        changed.decimals = base.decimals + 1;
        assertNotEq(registry.eventIdOf(sealer, changed), id, "decimals");
        changed = _threshold(32);
        changed.announcesAt = base.announcesAt + 1;
        assertNotEq(registry.eventIdOf(sealer, changed), id, "announcesAt");
        changed = _threshold(32);
        changed.deadline = base.deadline + 1;
        assertNotEq(registry.eventIdOf(sealer, changed), id, "deadline");
        changed = _threshold(32);
        changed.terms[0] = bytes1(uint8(changed.terms[0]) ^ 1);
        assertNotEq(registry.eventIdOf(sealer, changed), id, "terms");
    }

    /// @notice A seal stores the sealer, its block and the whole threshold, and reads them back
    ///         exactly, whether the terms fit in one slot or need several.
    function test_aSealReadsBackExactlyAtEveryTermsLength() public {
        uint256[5] memory lengths = [uint256(1), 31, 32, 33, 500];
        for (uint256 i = 0; i < lengths.length; i++) {
            ThresholdRegistry.Threshold memory threshold = _threshold(lengths[i]);
            vm.prank(sealer);
            bytes32 id = registry.seal(threshold);
            assertEq(id, registry.eventIdOf(sealer, threshold));
            (address sealedBy, uint256 sealBlock, ThresholdRegistry.Threshold memory read) =
                registry.sealOf(id);
            assertEq(sealedBy, sealer);
            assertEq(sealBlock, block.number);
            assertEq(keccak256(abi.encode(read)), keccak256(abi.encode(threshold)));
            assertEq(read.terms, threshold.terms);
        }
    }

    /// @notice The fixed fields read on their own, without the terms.
    function test_thresholdOfReadsTheFixedFields() public {
        ThresholdRegistry.Threshold memory threshold = _threshold(500);
        vm.prank(sealer);
        bytes32 id = registry.seal(threshold);
        (
            address sealedBy,
            uint256 sealBlock,
            int256 value,
            uint8 decimals,
            uint64 announcesAt,
            uint64 deadline
        ) = registry.thresholdOf(id);
        assertEq(sealedBy, sealer);
        assertEq(sealBlock, block.number);
        assertEq(value, threshold.value);
        assertEq(decimals, threshold.decimals);
        assertEq(announcesAt, threshold.announcesAt);
        assertEq(deadline, threshold.deadline);
    }

    /// @notice An unsealed id reads as nobody's, at block zero.
    function test_anUnsealedEventReadsAsNobodys() public view {
        (address sealedBy, uint256 sealBlock,,,,) = registry.thresholdOf(keccak256("never sealed"));
        assertEq(sealedBy, address(0));
        assertEq(sealBlock, 0);
    }

    /// @notice A seal announces its id, sealer, block and threshold.
    function test_aSealEmitsThresholdSealed() public {
        ThresholdRegistry.Threshold memory threshold = _threshold(33);
        vm.expectEmit(address(registry));
        emit ThresholdRegistry.ThresholdSealed(
            registry.eventIdOf(sealer, threshold), sealer, block.number, threshold
        );
        vm.prank(sealer);
        registry.seal(threshold);
    }

    /// @notice A sealed event is never sealed again.
    function test_RevertWhen_sealingTheSameEventTwice() public {
        ThresholdRegistry.Threshold memory threshold = _threshold(32);
        vm.prank(sealer);
        bytes32 id = registry.seal(threshold);
        vm.expectRevert(abi.encodeWithSelector(ThresholdRegistry.AlreadySealed.selector, id));
        vm.prank(sealer);
        registry.seal(threshold);
    }

    /// @notice Another sealer can seal the same threshold, under its own id.
    function test_anotherSealerCanSealTheSameThreshold() public {
        ThresholdRegistry.Threshold memory threshold = _threshold(32);
        vm.prank(sealer);
        bytes32 first = registry.seal(threshold);
        vm.prank(other);
        bytes32 second = registry.seal(threshold);
        assertNotEq(first, second);
    }

    /// @notice One second before the announcement is the last moment to seal.
    function test_sealingOneSecondBeforeTheAnnouncementSucceeds() public {
        ThresholdRegistry.Threshold memory threshold = _threshold(32);
        vm.warp(threshold.announcesAt - 1);
        vm.prank(sealer);
        registry.seal(threshold);
    }

    /// @notice Nothing is sealed at the announcement or after it.
    function test_RevertWhen_sealingAtOrAfterTheAnnouncement() public {
        ThresholdRegistry.Threshold memory threshold = _threshold(32);
        vm.warp(threshold.announcesAt);
        vm.expectRevert(
            abi.encodeWithSelector(ThresholdRegistry.TooLate.selector, threshold.announcesAt)
        );
        vm.prank(sealer);
        registry.seal(threshold);
        vm.warp(threshold.announcesAt + 1 days);
        vm.expectRevert(
            abi.encodeWithSelector(ThresholdRegistry.TooLate.selector, threshold.announcesAt)
        );
        vm.prank(sealer);
        registry.seal(threshold);
    }

    /// @notice The deadline comes after the announcement.
    function test_RevertWhen_deadlineIsNotAfterTheAnnouncement() public {
        ThresholdRegistry.Threshold memory threshold = _threshold(32);
        threshold.deadline = threshold.announcesAt;
        vm.expectRevert(ThresholdRegistry.DeadlineBeforeAnnouncement.selector);
        registry.seal(threshold);
    }

    /// @notice At most eighteen decimals, so scaling the threshold can never overflow.
    function test_RevertWhen_decimalsExceedEighteen() public {
        ThresholdRegistry.Threshold memory threshold = _threshold(32);
        threshold.decimals = 19;
        vm.expectRevert(
            abi.encodeWithSelector(ThresholdRegistry.DecimalsTooLarge.selector, uint8(19))
        );
        registry.seal(threshold);
    }

    /// @notice A threshold without terms says nothing a resolver could check.
    function test_RevertWhen_termsAreEmpty() public {
        ThresholdRegistry.Threshold memory threshold = _threshold(32);
        threshold.terms = "";
        vm.expectRevert(ThresholdRegistry.EmptyTerms.selector);
        registry.seal(threshold);
    }

    /// @notice A threshold a day ahead, with terms of a given length.
    /// @param length How many bytes of terms.
    /// @return threshold The threshold.
    function _threshold(uint256 length)
        internal
        view
        returns (ThresholdRegistry.Threshold memory threshold)
    {
        bytes memory terms = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            terms[i] = bytes1(uint8(97 + i % 26));
        }
        threshold = ThresholdRegistry.Threshold({
            value: 123,
            decimals: 2,
            announcesAt: uint64(block.timestamp + 1 days),
            deadline: uint64(block.timestamp + 9 days),
            terms: terms
        });
    }
}
