// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @title Deployed
/// @notice The smallest contract that can be created, so that what is under test is the address
///         and not the code at it.
contract Deployed {}

/// @title Create2Deployer
/// @notice Performs a deterministic creation with the machine's own opcode.
contract Create2Deployer {
    /// @notice Creates a contract deterministically under a salt.
    /// @param salt The salt to create under.
    /// @param initCode The creation code to run.
    /// @return created The address the machine assigned.
    function deploy(bytes32 salt, bytes memory initCode) external returns (address created) {
        assembly {
            created := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
    }
}

/// @title Create2AddressTest
/// @notice Holds the prediction of a deterministic address to what the machine actually does,
///         over arbitrary salts. A fixed-vector test would not notice a change in how a salt is
///         derived, and both the recorded deployment scheme and an address that has to be
///         searched for rest on prediction and creation agreeing.
contract Create2AddressTest is Test {
    /// @notice The deterministic factory, identical on every chain this project uses.
    /// @dev Its own code is irrelevant to the result: a deterministic address is a function of
    ///      the creating address, the salt and the hash of the creation code, and of nothing
    ///      else. So the creation is performed from this address with the plain opcode rather
    ///      than against a copy of the factory's bytecode, which would be a second home for a
    ///      fact that already has one.
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice The prediction equals the address the machine produces, for any salt.
    /// @param salt The salt to create under.
    function testFuzz_predictionMatchesTheMachine(bytes32 salt) public {
        bytes memory initCode = type(Deployed).creationCode;
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), FACTORY);

        vm.etch(FACTORY, address(new Create2Deployer()).code);
        address produced = Create2Deployer(FACTORY).deploy(salt, initCode);

        assertEq(produced, predicted);
        assertGt(produced.code.length, 0, "nothing was created at the produced address");
    }
}
