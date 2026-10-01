// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @title Toolchain
/// @notice Proves the compiler targets an EVM that provides transient storage.
contract ToolchainTest is Test {
    /// @notice Writes and reads a transient storage slot and asserts it round-trips.
    function test_transientStorageIsAvailable() public {
        uint256 read;
        assembly {
            tstore(0, 42)
            read := tload(0)
        }
        assertEq(read, 42);
    }
}
