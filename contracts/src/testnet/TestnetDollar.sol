// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestnetToken} from "./TestnetToken.sol";

/// @title TestnetDollar
/// @notice The test network's dollar: six decimals, like the dollar the production markets use.
contract TestnetDollar is TestnetToken {
    /// @notice Creates the dollar with its owner.
    /// @param owner_ The owner, who mints for seeding.
    constructor(address owner_) TestnetToken("Test Dollar", "TUSD", owner_) {}

    /// @notice Six decimals.
    /// @return The number of decimals.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice A thousand test dollars.
    /// @return The amount, in the token's smallest unit.
    function DRIP() public pure override returns (uint256) {
        return 1000e6;
    }
}
