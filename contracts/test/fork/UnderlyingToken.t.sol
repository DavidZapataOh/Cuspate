// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AddressBook} from "../../script/AddressBook.sol";

/// @title IUnderlying
/// @notice The reads and the one write this selection needs from the collateral it depends on.
interface IUnderlying {
    /// @notice The number of decimals the token reports.
    /// @return The decimals.
    function decimals() external view returns (uint8);

    /// @notice What an address holds.
    /// @param holder The address to read.
    /// @return The amount held.
    function balanceOf(address holder) external view returns (uint256);

    /// @notice Moves an amount from the caller to a recipient.
    /// @param to The recipient.
    /// @param amount How much to move.
    /// @return Whether the move succeeded.
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title UnderlyingTokenTest
/// @notice Reads the collateral this project depends on as it actually was, at a pinned block on
///         the chain that matters. Nothing local can see any of this: the token's logic is
///         replaceable by whoever controls its beacon, and its administrator can refuse
///         transfers and deny individual holders.
///
///         What this proves and what it does not. It proves this code works against the bytecode
///         that was at that address at that block. It does not prove the token will behave that
///         way tomorrow; that exposure belongs to a threat model and a live watcher, not to a
///         test.
contract UnderlyingTokenTest is Test {
    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    /// @notice The decimals the record expects this collateral to report.
    uint8 internal constant EXPECTED_DECIMALS = 18;

    IUnderlying internal collateral;
    uint256 internal pinned;

    /// @notice Opens on a fork at the pinned block and proves it is really there.
    function setUp() public {
        // The reader selects its file by chain id, and the pin has to be read before a fork can
        // be created at it.
        vm.chainId(PRODUCTION_CHAIN);
        pinned = AddressBook.pinnedBlock();

        // An alias, never a URL. The alias resolves with nothing set; the variable is an
        // override for whoever needs a different door to the same chain.
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);

        collateral = IUnderlying(AddressBook.thirdParty("collateral", 0));

        // The positive check, and a read of real state. Without a fork the chain id is the local
        // one and the code size is zero, so this cannot pass against an empty local chain.
        assertEq(block.chainid, PRODUCTION_CHAIN, "not on a fork of the production chain");
        assertEq(block.number, pinned, "not at the pinned block");
        assertGt(
            address(collateral).code.length,
            0,
            "no code at the recorded address at the pinned block: if the endpoint no longer "
            "serves this block, re-pin it; the assertion itself is not what failed"
        );
    }

    /// @notice The collateral reports the decimals the record expects.
    function testFork_collateralReportsTheRecordedDecimals() public view {
        assertEq(collateral.decimals(), EXPECTED_DECIMALS);
    }

    /// @notice An address nobody authorised can hold the collateral and then send it on.
    /// @dev This is the one fact the whole design rests on: the mechanism is a denylist and not
    ///      an allowlist, so a vault needs nobody's permission to hold or move it.
    ///
    ///      Two honesty caveats. The balance is fabricated, and it is larger than the token's
    ///      entire real issuance while the recorded supply is left untouched — so the fork now
    ///      holds internally inconsistent state and no test may read the supply beside it. And
    ///      because the balance is written directly, this proves the *send* path is permissionless
    ///      while the receive half is simulated rather than observed.
    function testFork_anArbitraryHolderCanReceiveAndSend() public {
        address holder = address(uint160(uint256(keccak256("holder"))));
        address recipient = address(uint160(uint256(keccak256("recipient"))));
        uint256 amount = 10 ** EXPECTED_DECIMALS;

        deal(address(collateral), holder, amount);
        assertEq(collateral.balanceOf(holder), amount, "the balance was not placed");

        vm.prank(holder);
        assertTrue(collateral.transfer(recipient, amount), "the transfer was refused");
        assertEq(collateral.balanceOf(recipient), amount, "the recipient did not receive it");
        assertEq(collateral.balanceOf(holder), 0, "the sender was not debited");
    }
}
