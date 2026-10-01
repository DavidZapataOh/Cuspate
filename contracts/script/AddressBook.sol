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
    /// @dev Read through the cheatcode rather than from `block.chainid`, which the compiler is
    ///      free to reuse across a change of fork — so a reader called after selecting a fork
    ///      would resolve the file of the chain it was on before.
    /// @return The path, selected by the chain id the chain itself reports.
    function path() internal view returns (string memory) {
        return string.concat("./deployments/", VM.toString(VM.getChainId()), ".json");
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

    /// @notice How many third-party addresses are recorded under a key.
    /// @param key The key to count.
    /// @return The number recorded, which is zero when the key is absent.
    function thirdPartyCount(string memory key) internal view returns (uint256) {
        string memory file = path();
        if (!VM.exists(file)) {
            return 0;
        }
        string memory json = VM.readFile(file);
        string memory pointer = string.concat(".thirdParty.", key);
        if (!VM.keyExistsJson(json, pointer)) {
            return 0;
        }
        return VM.parseJsonAddressArray(json, pointer).length;
    }

    /// @notice One of the third-party addresses recorded under a key.
    /// @dev Keyed by a list rather than a single value, so that how many of a thing there are
    ///      stays a question the data answers rather than one this shape decides.
    /// @param key The key to resolve.
    /// @param index Which of the addresses recorded under that key.
    /// @return The recorded address.
    function thirdParty(string memory key, uint256 index) internal view returns (address) {
        if (index >= thirdPartyCount(key)) {
            revert KeyMissing(key);
        }
        return
            VM.parseJsonAddressArray(VM.readFile(path()), string.concat(".thirdParty.", key))[index];
    }

    /// @notice The block this repository pins for reads of historical state on this chain.
    /// @return The pinned block number.
    function pinnedBlock() internal view returns (uint256) {
        string memory file = path();
        if (!VM.exists(file)) {
            revert KeyMissing("pinnedBlock");
        }
        string memory json = VM.readFile(file);
        if (!VM.keyExistsJson(json, ".pinnedBlock")) {
            revert KeyMissing("pinnedBlock");
        }
        return VM.parseJsonUint(json, ".pinnedBlock");
    }
}
