// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AddressBook} from "../../script/AddressBook.sol";

/// @title AddressBookReader
/// @notice Reaches the reader through a call boundary, which is what a revert has to cross
///         before it can be asserted by selector.
contract AddressBookReader {
    /// @notice Resolves a key recorded by this repository's own deployments.
    /// @param key The key to resolve.
    /// @return The recorded address.
    function get(string memory key) external view returns (address) {
        return AddressBook.get(key);
    }

    /// @notice Resolves one of the third-party addresses recorded under a key.
    /// @param key The key to resolve.
    /// @param index Which of the addresses recorded under that key.
    /// @return The recorded address.
    function thirdParty(string memory key, uint256 index) external view returns (address) {
        return AddressBook.thirdParty(key, index);
    }
}

/// @title AddressBookTest
/// @notice Exercises the reader the deploy pipeline built and never called from Solidity.
contract AddressBookTest is Test {
    /// @notice The address the committed record holds, asserted here as a literal so that the
    ///         record and this expectation are two separate statements that must agree.
    address internal constant RECORDED = 0x4e48788294BCEDE593b24aEC0536797D1d62C60f;

    AddressBookReader internal reader;

    /// @notice Builds the reader and places the test on the chain whose record exists.
    function setUp() public {
        reader = new AddressBookReader();
        // The reader selects its file by the chain id, and this selection does not run on a
        // fork, so without this it looks for a record that is not there.
        vm.chainId(10143);
    }

    /// @notice A recorded key resolves to the address the record holds.
    function test_recordedKeyResolvesToTheRecordedAddress() public view {
        assertEq(reader.get("Probe"), RECORDED);
    }

    /// @notice An absent key is refused by a typed error that names it.
    function test_RevertWhen_keyIsAbsent() public {
        vm.expectRevert(abi.encodeWithSelector(AddressBook.KeyMissing.selector, "Absent"));
        reader.get("Absent");
    }

    /// @notice An absent third-party key is refused the same way, by the same typed error.
    function test_RevertWhen_thirdPartyKeyIsAbsent() public {
        vm.expectRevert(abi.encodeWithSelector(AddressBook.KeyMissing.selector, "absent"));
        reader.thirdParty("absent", 0);
    }
}
