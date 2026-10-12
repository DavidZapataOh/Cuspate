// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {Outcome} from "../../src/PositionVault.sol";
import {ResolverStates} from "./ArbiterReach.t.sol";

/// @title TerminationTest
/// @notice Every sealed event resolves and every bond is accounted for, whatever state it was left
///         in: once enough time has passed, a stranger with no bond and no privilege can end it.
contract TerminationTest is ResolverStates {
    /// @notice From every state of a sealed event, after every clock has run out, a stranger's
    ///         settlement, release and expiry leave the event resolved and no bond held: everything
    ///         the resolver holds is owed to someone or burned.
    /// @param stateSeed Chooses the state.
    /// @param laterSeed Chooses how long after every clock the stranger acts.
    function testFuzz_everyEventResolvesAndEveryBondIsAccountedFor(
        uint256 stateSeed,
        uint256 laterSeed
    ) public {
        uint256 state = stateSeed % STATES;
        // An unsealed event is never resolved, by decision; markets over it exit by merging.
        if (state == UNSEALED) state = NO_PROPOSAL;
        bytes32 id = _build(state);
        vm.warp(uint256(threshold.deadline) + 60 days + laterSeed % 30 days);

        vm.startPrank(stranger);
        _attempt(abi.encodeCall(OptimisticResolver.settle, (id)));
        _attempt(abi.encodeCall(OptimisticResolver.release, (id)));
        _attempt(abi.encodeCall(OptimisticResolver.expire, (id)));
        vm.stopPrank();

        assertTrue(_outcomeOf(id) != Outcome.Unresolved, "an event was left unresolved");
        address[4] memory parties = [proposer, disputer, arbiter, stranger];
        uint256 owed;
        for (uint256 i = 0; i < parties.length; i++) {
            owed += resolver.owed(parties[i]);
        }
        assertEq(
            dollar.balanceOf(address(resolver)), owed + resolver.burned(), "a bond is still held"
        );
    }

    /// @notice Calls the resolver, accepting a refusal: which exits apply depends on the state.
    /// @param data The call.
    function _attempt(bytes memory data) internal {
        (bool succeeded,) = address(resolver).call(data);
        succeeded;
    }
}
