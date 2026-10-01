// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {StdUtils} from "forge-std/StdUtils.sol";
import {Ledger} from "../helpers/Ledger.sol";

/// @title LedgerHandler
/// @notice The only thing a campaign against this subject may call. Every input is narrowed by
///         bounding and never by assumption: an assumption discards the run and silently
///         shortens the campaign, while bounding keeps it. It also counts the calls that
///         changed state, so a campaign that made every call and touched nothing is visible.
/// @dev Not a test file. A collected file with no tests is noise in every count.
contract LedgerHandler is StdUtils {
    /// @notice The subject this handler is allowed to drive.
    Ledger public immutable ledger;

    /// @notice How many calls actually changed the subject's state.
    uint256 public stateChangingCalls;

    address[] private _holders;

    /// @notice Builds the handler over a subject and fixes the set of holders it may use.
    /// @param ledger_ The subject to drive.
    constructor(Ledger ledger_) {
        ledger = ledger_;
        for (uint160 index = 1; index <= 5; index++) {
            _holders.push(address(index));
        }
    }

    /// @notice The holders this handler draws from, which is also what the property sums over.
    /// @return The fixed holder set.
    function holders() external view returns (address[] memory) {
        return _holders;
    }

    /// @notice The sum of the recorded balances across every holder this handler can reach.
    /// @return sum The sum.
    function sumOfBalances() external view returns (uint256 sum) {
        for (uint256 index = 0; index < _holders.length; index++) {
            sum += ledger.balanceOf(_holders[index]);
        }
    }

    /// @notice Credits a bounded amount to one of the holders.
    /// @param holderSeed Chooses the holder.
    /// @param amount Bounded to something the subject accepts.
    function credit(uint256 holderSeed, uint256 amount) external {
        address holder = _holders[_bound(holderSeed, 0, _holders.length - 1)];
        ledger.credit(holder, _bound(amount, 1, 1e24));
        stateChangingCalls++;
    }

    /// @notice Moves a bounded amount between two of the holders.
    /// @param fromSeed Chooses the giver.
    /// @param toSeed Chooses the receiver.
    /// @param amount Bounded to what the giver actually holds.
    function move(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = _holders[_bound(fromSeed, 0, _holders.length - 1)];
        address to = _holders[_bound(toSeed, 0, _holders.length - 1)];
        uint256 held = ledger.balanceOf(from);
        if (held == 0) {
            // Nothing to move is not a refusal to record: with refusal-on-revert on, a call the
            // subject would reject aborts the campaign, so the handler declines to make it.
            ledger.credit(from, _bound(amount, 1, 1e24));
            stateChangingCalls++;
            return;
        }
        ledger.move(from, to, _bound(amount, 1, held));
        stateChangingCalls++;
    }
}
