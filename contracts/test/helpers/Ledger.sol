// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @title Ledger
/// @notice Integer bookkeeping with one property worth stating: the recorded total is always
///         the sum of the recorded balances. It has no privileged function, because nothing
///         here would assert one and leaving one would invite an access-control test to be
///         written inside a meter's subject.
contract Ledger {
    /// @notice Thrown when a holder is asked to give up more than it holds.
    /// @param holder The holder that was asked.
    /// @param held What it holds.
    /// @param requested What was asked of it.
    error InsufficientBalance(address holder, uint256 held, uint256 requested);

    /// @notice Thrown when a movement of nothing is requested.
    error NothingToMove();

    /// @notice What each holder holds.
    mapping(address holder => uint256 amount) public balanceOf;

    /// @notice The recorded total across all holders.
    uint256 public total;

    /// @notice Records an increase for a holder, raising the total by the same amount.
    /// @param holder The holder to credit.
    /// @param amount How much to credit.
    function credit(address holder, uint256 amount) external {
        if (amount == 0) {
            revert NothingToMove();
        }
        balanceOf[holder] += amount;
        total += amount;
    }

    /// @notice Moves a recorded amount between holders, leaving the total untouched.
    /// @param from The holder giving up the amount.
    /// @param to The holder receiving it.
    /// @param amount How much to move.
    function move(address from, address to, uint256 amount) external {
        if (amount == 0) {
            revert NothingToMove();
        }
        uint256 held = balanceOf[from];
        if (held < amount) {
            revert InsufficientBalance(from, held, amount);
        }
        balanceOf[from] = held - amount;
        balanceOf[to] += amount;
    }
}
