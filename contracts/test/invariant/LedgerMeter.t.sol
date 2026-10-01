// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ledger} from "../helpers/Ledger.sol";
import {LedgerHandler} from "./LedgerHandler.sol";

/// @title LedgerMeterTest
/// @notice A campaign whose purpose is to be measured. It exists so that the meters around it
///         can be shown to fail on a campaign that reverts, on one that makes no calls, and on
///         one that changes nothing — the three ways a campaign reports safety it has not
///         established. The properties a protocol will need are not these.
contract LedgerMeterTest is Test {
    Ledger internal ledger;
    LedgerHandler internal handler;
    uint256 internal startingTotal;

    /// @notice Builds the subject and registers the handler as the campaign's only target.
    function setUp() public {
        ledger = new Ledger();
        handler = new LedgerHandler(ledger);
        // Only a handler is ever a target. With none registered the runner calls the subject
        // directly with raw calldata, which is how a campaign reaches a high revert rate and
        // still passes.
        targetContract(address(handler));
        startingTotal = ledger.total();
    }

    /// @notice The recorded total is the sum of the recorded balances.
    function invariant_totalEqualsSumOfBalances() public view {
        assertEq(ledger.total(), handler.sumOfBalances());
    }

    /// @notice No holder is recorded as holding more than the total.
    function invariant_noHolderExceedsTheTotal() public view {
        address[] memory holders = handler.holders();
        for (uint256 index = 0; index < holders.length; index++) {
            assertLe(ledger.balanceOf(holders[index]), ledger.total());
        }
    }

    /// @notice Closes the campaign by proving it did something.
    /// @dev The dual of a reverting campaign: a handler whose calls do nothing reverts never,
    ///      makes every call, and establishes nothing at all.
    function afterInvariant() public view {
        assertGt(handler.stateChangingCalls(), 0, "the campaign changed no state");
        assertNotEq(ledger.total(), startingTotal, "the subject ended where it started");
    }
}
