// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title PositionToken
/// @notice One leg of a conditional position: a claim on one unit of a collateral if its outcome
///         resolves true. Only the minter fixed at construction can create or destroy it.
/// @dev Plain by design. No permit, no hooks, no pause and no supply cap, because each would be a
///      behaviour the minter's accounting must reason about, and a pool needs only the standard
///      interface to hold and move it.
contract PositionToken is ERC20 {
    /// @notice Thrown when anything other than the minter tries to mint or burn.
    /// @param caller The address that tried.
    error NotMinter(address caller);

    /// @notice Thrown when constructed with no minter, which would leave the token unmintable.
    error ZeroMinter();

    /// @notice The only address that can mint and burn this token. It can burn any holder's
    ///         balance without an allowance, and it is fixed for the token's lifetime.
    address public immutable MINTER;

    uint8 private immutable DECIMALS;

    /// @notice Creates a leg.
    /// @param name_ The token's name.
    /// @param symbol_ The token's symbol.
    /// @param decimals_ The collateral's decimals, so that one unit of the leg is a claim on one
    ///        unit of the collateral.
    /// @param minter The only address that will ever mint or burn this token.
    constructor(string memory name_, string memory symbol_, uint8 decimals_, address minter)
        ERC20(name_, symbol_)
    {
        if (minter == address(0)) {
            revert ZeroMinter();
        }
        MINTER = minter;
        DECIMALS = decimals_;
    }

    /// @notice The collateral's decimals.
    /// @return The number of decimals.
    function decimals() public view override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Creates an amount of this leg for a holder.
    /// @param to The holder credited.
    /// @param amount How much is created.
    /// @custom:access minter
    function mint(address to, uint256 amount) external {
        _requireMinter();
        _mint(to, amount);
    }

    /// @notice Destroys an amount of this leg from a holder, with no allowance.
    /// @param from The holder debited.
    /// @param amount How much is destroyed.
    /// @custom:access minter
    function burn(address from, uint256 amount) external {
        _requireMinter();
        _burn(from, amount);
    }

    /// @notice Refuses every caller but the minter.
    function _requireMinter() private view {
        if (msg.sender != MINTER) {
            revert NotMinter(msg.sender);
        }
    }
}
