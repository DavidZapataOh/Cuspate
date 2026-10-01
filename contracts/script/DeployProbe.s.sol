// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AddressBook} from "./AddressBook.sol";

/// @title Probe
/// @notice A contract with no protocol role, declared here rather than among the
///         sources so that nothing mistakes it for one. It exists to be the subject of
///         the deployment pipeline's own proof, and its entry in the record is the
///         permanent evidence of the first scripted deployment.
contract Probe {
    /// @notice Returns a fixed value, so the deployed code has observable behaviour.
    /// @return The one value this contract was created to return.
    function answer() external pure returns (uint256) {
        return 1;
    }
}

/// @title DeployProbe
/// @notice Rehearses one deployment. It computes the address the wrapper is about to
///         create, independently of the wrapper, and records what it computed so the
///         wrapper can refuse a disagreement. It never broadcasts and never writes the
///         record the repository commits.
contract DeployProbe is Script {
    /// @notice The deterministic factory, identical on every chain this project uses.
    address public constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice The string the default salt is derived from.
    string public constant SALT_SEED = "cuspate.probe.v1";

    /// @notice Thrown when the address about to be created already holds code.
    /// @param at The address that is already occupied.
    error AlreadyDeployed(address at);

    /// @notice Computes the salt, the creation code and the address, checks them against
    ///         the wrapper's prediction and against the chain, and writes the record it
    ///         would have written to a discarded path so that the step is rehearsed.
    function run() external {
        bytes32 salt = bytes32(vm.envOr("PROBE_SALT", keccak256(bytes(SALT_SEED))));
        bytes memory initCode = type(Probe).creationCode;
        address computed = vm.computeCreate2Address(salt, keccak256(initCode), FACTORY);

        if (computed.code.length != 0) {
            revert AlreadyDeployed(computed);
        }

        // The record is written by the wrapper from a receipt. This writes the part of
        // the entry that is known before the transaction exists, to a path outside
        // version control, so the composition is exercised on every rehearsal.
        string memory handle = "entry";
        vm.serializeAddress(handle, "address", computed);
        vm.serializeAddress(handle, "factory", FACTORY);
        vm.serializeBytes32(handle, "salt", salt);
        string memory json = vm.serializeBytes(handle, "constructorArgs", "");
        vm.writeJson(
            json, string.concat("./deployments/.rehearsal/", vm.toString(block.chainid), ".json")
        );

        if (AddressBook.has("Probe")) {
            console.log("the record already holds this key for this chain");
        }
    }
}
