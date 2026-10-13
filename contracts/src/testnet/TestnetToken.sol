// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title TestnetToken
/// @notice A token with no value anywhere, for the test network: its owner mints what seeding
///         needs, and anyone takes a fixed amount once per cooldown, so a visitor can try the
///         product without asking anyone for funds.
abstract contract TestnetToken is ERC20, TestnetOnly {
    /// @notice How long an address waits between two drips.
    uint256 public constant COOLDOWN = 1 days;

    /// @notice When each address last dripped, in Unix seconds.
    mapping(address account => uint256 at) public lastDrip;

    /// @notice Creates the token with its owner.
    /// @param name_ The token's name.
    /// @param symbol_ The token's symbol.
    /// @param owner_ The owner, who mints.
    constructor(string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_)
        TestnetOnly(owner_)
    {}

    /// @notice How much one drip gives.
    /// @return The amount, in the token's smallest unit.
    function DRIP() public pure virtual returns (uint256);

    /// @notice Creates an amount for a holder.
    /// @param to The holder credited.
    /// @param amount How much is created.
    /// @custom:access owner
    function mint(address to, uint256 amount) external {
        _requireOwner();
        _mint(to, amount);
    }

    /// @notice Gives the caller one drip, once per cooldown.
    /// @custom:access anyone
    function drip() external {
        uint256 last = lastDrip[msg.sender];
        // A rate limit measured in days for a token with no value: a validator's seconds of
        // leeway cannot matter, so the block's own clock is the right one.
        // forge-lint: disable-next-line(block-timestamp)
        if (last != 0 && block.timestamp < last + COOLDOWN) {
            revert TooSoon(last + COOLDOWN);
        }
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, DRIP());
    }
}
