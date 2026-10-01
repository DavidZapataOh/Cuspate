// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @title AddressBook
/// @notice Reads the generated record of the addresses this repository has deployed on
///         the chain currently in use. It only reads: the record is written by the
///         deploy wrapper, from a transaction receipt, and by nothing else.
library AddressBook {
    /// @notice Thrown when the book for this chain holds no entry under a key.
    /// @param key The key that was not found.
    error KeyMissing(string key);

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice The path of the book for the chain currently in use.
    /// @return The path, selected by the chain id the chain itself reports.
    function path() internal view returns (string memory) {
        return string.concat("./deployments/", VM.toString(block.chainid), ".json");
    }

    /// @notice Whether the book holds an entry under a key.
    /// @param key The key to look for.
    /// @return True when an address is recorded under the key.
    function has(string memory key) internal view returns (bool) {
        string memory file = path();
        if (!VM.exists(file)) {
            return false;
        }
        // Checked before parsing: a parse failure on a missing key is an untyped string
        // that cannot be told apart from a malformed value.
        return VM.keyExistsJson(VM.readFile(file), string.concat(".", key, ".address"));
    }

    /// @notice The address recorded under a key.
    /// @param key The key to resolve.
    /// @return The recorded address.
    function get(string memory key) internal view returns (address) {
        if (!has(key)) {
            revert KeyMissing(key);
        }
        return VM.parseJsonAddress(VM.readFile(path()), string.concat(".", key, ".address"));
    }
}
