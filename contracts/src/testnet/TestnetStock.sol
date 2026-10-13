// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TestnetToken} from "./TestnetToken.sol";

/// @title TestnetStock
/// @notice A test network's stand-in for one tokenized share: eighteen decimals, like the shares
///         the production markets use, and a symbol the price feed knows it by.
contract TestnetStock is TestnetToken {
    /// @notice Creates the share with its owner.
    /// @param name_ The token's name.
    /// @param symbol_ The share's symbol.
    /// @param owner_ The owner, who mints for seeding.
    constructor(string memory name_, string memory symbol_, address owner_)
        TestnetToken(name_, symbol_, owner_)
    {}

    /// @notice One share.
    /// @return The amount, in the token's smallest unit.
    function DRIP() public pure override returns (uint256) {
        return 1e18;
    }
}
