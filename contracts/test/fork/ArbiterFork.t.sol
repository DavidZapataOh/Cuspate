// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {Outcome} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";

/// @notice A Safe, as far as this suite uses it.
interface ISafe {
    /// @notice Sets the owners, the threshold and the fallback handler, once.
    /// @param owners The owners.
    /// @param threshold How many must sign.
    /// @param to A contract to delegatecall during setup; none here.
    /// @param data Its calldata.
    /// @param fallbackHandler The fallback handler.
    /// @param paymentToken Token a setup payment is made in; none here.
    /// @param payment The payment.
    /// @param paymentReceiver Who receives it.
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address paymentReceiver
    ) external;

    /// @notice Executes a call signed by the owners.
    /// @param to The target.
    /// @param value The value.
    /// @param data The calldata.
    /// @param operation Zero for a call.
    /// @param safeTxGas Gas for the inner call; zero for all.
    /// @param baseGas Gas outside it, for refunds.
    /// @param gasPrice The refund price; zero for none.
    /// @param gasToken The refund token.
    /// @param refundReceiver The refund receiver.
    /// @param signatures The owners' signatures, ordered by owner.
    /// @return success Whether the inner call succeeded.
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    /// @notice The hash the owners sign.
    /// @param to The target.
    /// @param value The value.
    /// @param data The calldata.
    /// @param operation Zero for a call.
    /// @param safeTxGas Gas for the inner call.
    /// @param baseGas Gas outside it.
    /// @param gasPrice The refund price.
    /// @param gasToken The refund token.
    /// @param refundReceiver The refund receiver.
    /// @param nonce The Safe's nonce.
    /// @return The hash.
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);

    /// @notice The next transaction's nonce.
    /// @return The nonce.
    function nonce() external view returns (uint256);

    /// @notice The owners.
    /// @return The owners.
    function getOwners() external view returns (address[] memory);

    /// @notice How many owners must sign.
    /// @return The threshold.
    function getThreshold() external view returns (uint256);

    /// @notice A page of enabled modules.
    /// @param start Where to start.
    /// @param pageSize How many.
    /// @return array The modules.
    /// @return next Where the next page starts.
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);

    /// @notice Raw storage.
    /// @param offset The first slot.
    /// @param length How many slots.
    /// @return The bytes.
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);

    /// @notice The contract version.
    /// @return The version.
    function VERSION() external view returns (string memory);
}

/// @notice The canonical Safe proxy factory, as far as this suite uses it.
interface ISafeProxyFactory {
    /// @notice Creates a Safe proxy and calls its initializer.
    /// @param singleton The Safe implementation.
    /// @param initializer The setup call.
    /// @param saltNonce A salt.
    /// @return proxy The Safe.
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @title ArbiterForkTest
/// @notice The arbiter as it will be: a two-of-three Safe created through the canonical factory on the
///         production chain at a pinned block, ruling a deadlocked event whose bonds are in the real
///         dollar. Two owners' signatures rule; one does not; a ruling the resolver refuses spends no
///         nonce.
contract ArbiterForkTest is Test {
    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;
    /// @notice The Safe's guard slot.
    uint256 internal constant GUARD_SLOT =
        0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    /// @notice The Safe's fallback-handler slot.
    uint256 internal constant FALLBACK_HANDLER_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
    /// @notice The start of a Safe's module list.
    address internal constant SENTINEL = address(0x1);

    uint256 internal constant BOND = 500e6;
    uint256 internal constant LIVENESS = 2 hours;
    string internal constant REASON = "the primary source published 1.25";

    uint256[3] internal keys = [uint256(0xA11CE), 0xB0B, 0xCA401];
    address internal fallbackHandler;
    ISafe internal safe;
    MarketFactory internal factory;
    OptimisticResolver internal resolver;
    bytes32 internal eventId;

    /// @notice A two-of-three Safe as arbiter, and an event over the real dollar disputed twice.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);
        assertEq(block.chainid, PRODUCTION_CHAIN, "not on a fork of the production chain");
        assertEq(block.number, pinned, "not at the pinned block");

        address[] memory owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            owners[i] = vm.addr(keys[i]);
        }
        fallbackHandler = AddressBook.thirdParty("safeFallbackHandler", 0);
        safe = ISafe(
            ISafeProxyFactory(AddressBook.thirdParty("safeProxyFactory", 0))
                .createProxyWithNonce(
                    AddressBook.thirdParty("safeSingleton", 0),
                    abi.encodeCall(
                        ISafe.setup,
                        (owners, 2, address(0), "", fallbackHandler, address(0), 0, address(0))
                    ),
                    0
                )
        );

        IERC20 dollar = IERC20(AddressBook.thirdParty("dollar", 0));
        ThresholdRegistry registry = new ThresholdRegistry();
        factory = new MarketFactory();
        address sealer = makeAddr("sealer");
        resolver = new OptimisticResolver(
            factory,
            registry,
            sealer,
            address(safe),
            dollar,
            BOND,
            BOND / 5,
            LIVENESS,
            7 days,
            7 days
        );
        uint64 announcesAt = uint64(vm.getBlockTimestamp() + 1 days);
        vm.prank(sealer);
        eventId = registry.seal(
            ThresholdRegistry.Threshold({
                value: 123,
                decimals: 2,
                announcesAt: announcesAt,
                deadline: announcesAt + 8 days,
                terms: "earnings per share, diluted, as first published"
            })
        );
        vm.warp(announcesAt);
        address[2] memory parties = [makeAddr("proposer"), makeAddr("disputer")];
        for (uint256 i = 0; i < 2; i++) {
            deal(address(dollar), parties[i], 4 * BOND);
            vm.prank(parties[i]);
            dollar.approve(address(resolver), 4 * BOND);
        }
        for (uint256 round = 0; round < 2; round++) {
            vm.prank(parties[0]);
            resolver.proposeFigure(eventId, 120, 2);
            vm.prank(parties[1]);
            resolver.dispute(eventId, uint8(round));
        }
        assertTrue(resolver.eventOf(eventId).pendingArbitration);
    }

    /// @notice The Safe is what the disclosure says: two of three owners, no module, no guard, the
    ///         canonical fallback handler, version 1.4.1.
    function testFork_theArbiterIsATwoOfThreeSafeWithNothingElse() public view {
        assertEq(safe.getThreshold(), 2);
        assertEq(safe.getOwners().length, 3);
        (address[] memory modules,) = safe.getModulesPaginated(SENTINEL, 10);
        assertEq(modules.length, 0, "a module is enabled");
        assertEq(
            abi.decode(safe.getStorageAt(GUARD_SLOT, 1), (address)), address(0), "a guard is set"
        );
        assertEq(
            abi.decode(safe.getStorageAt(FALLBACK_HANDLER_SLOT, 1), (address)),
            fallbackHandler,
            "the fallback handler is not the canonical one"
        );
        assertEq(safe.VERSION(), "1.4.1");
    }

    /// @notice Two owners' signatures rule the deadlocked event: the outcome is reported and the
    ///         ruling's reason is stored.
    function testFork_twoSignaturesRuleTheDeadlock() public {
        bytes memory data = _ruling(false);
        safe.execTransaction(
            address(resolver),
            0,
            data,
            0,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _sign(data, 2, false)
        );
        assertEq(
            uint8(factory.outcomeOf(factory.condition(address(resolver), eventId))),
            uint8(Outcome.Yes)
        );
        assertEq(resolver.eventOf(eventId).outcomeReason, REASON);
        assertEq(safe.nonce(), 1);
    }

    /// @notice One owner's signature is refused by the Safe.
    function testFork_oneSignatureIsRefused() public {
        bytes memory data = _ruling(false);
        bytes memory signatures = _sign(data, 1, false);
        vm.expectRevert(bytes("GS020"));
        safe.execTransaction(
            address(resolver), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures
        );
    }

    /// @notice A signature by anyone but an owner is refused by the Safe.
    function testFork_aStrangersSignatureIsRefused() public {
        bytes memory data = _ruling(false);
        bytes memory signatures = _sign(data, 2, true);
        vm.expectRevert(bytes("GS026"));
        safe.execTransaction(
            address(resolver), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures
        );
    }

    /// @notice A ruling the resolver refuses fails the whole transaction and spends no nonce.
    function testFork_aRefusedRulingSpendsNoNonce() public {
        bytes memory data = _ruling(true);
        bytes memory signatures = _sign(data, 2, false);
        vm.expectRevert(bytes("GS013"));
        safe.execTransaction(
            address(resolver), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures
        );
        assertEq(safe.nonce(), 0);
    }

    /// @notice A ruling of 1.25 for the deadlocked event.
    /// @param proposerRight Whether to rule the second proposer right, which the resolver refuses,
    ///        since it proposed 1.20.
    /// @return The calldata.
    function _ruling(bool proposerRight) internal view returns (bytes memory) {
        return
            abi.encodeCall(OptimisticResolver.ruleFigure, (eventId, 125, 2, proposerRight, REASON));
    }

    /// @notice Signs a call to the resolver with the first owners, ordered by address as the Safe
    ///         requires.
    /// @param data The calldata.
    /// @param count How many owners sign.
    /// @param stranger Whether a key that is not an owner signs in place of the last owner.
    /// @return signatures The signatures.
    function _sign(bytes memory data, uint256 count, bool stranger)
        internal
        view
        returns (bytes memory signatures)
    {
        bytes32 hash = safe.getTransactionHash(
            address(resolver), 0, data, 0, 0, 0, 0, address(0), address(0), safe.nonce()
        );
        uint256[] memory signers = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            signers[i] = keys[i];
        }
        if (stranger) signers[count - 1] = 0xDEAD;
        for (uint256 i = 0; i < count; i++) {
            for (uint256 j = i + 1; j < count; j++) {
                if (vm.addr(signers[j]) < vm.addr(signers[i])) {
                    (signers[i], signers[j]) = (signers[j], signers[i]);
                }
            }
        }
        for (uint256 i = 0; i < count; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signers[i], hash);
            signatures = abi.encodePacked(signatures, r, s, v);
        }
    }
}
