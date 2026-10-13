// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title TestnetOnly
/// @notice What every contract in this directory shares: it can exist only on the public test
///         network or on a local chain, and one owner fixed at construction runs it.
/// @dev The deterministic deployer exists on the production chain with the same bytecode, so
///      anyone could replay a test contract's salt and creation code there and obtain the same
///      address. The constructor refuses any other chain, which makes that replay revert.
abstract contract TestnetOnly {
    /// @notice Thrown when constructed on a chain that is neither the test network nor local.
    /// @param chainId The chain it was attempted on.
    error NotATestChain(uint256 chainId);

    /// @notice Thrown when constructed with no owner, which would leave it unrunnable.
    error ZeroOwner();

    /// @notice Thrown when anything other than the owner calls an owner's function.
    /// @param caller The address that tried.
    error NotOwner(address caller);

    /// @notice Thrown when an address asks again before its cooldown has passed.
    /// @param next When it may ask again, in Unix seconds.
    error TooSoon(uint256 next);

    /// @notice The public test network's chain id.
    uint256 public constant TEST_NETWORK = 10_143;

    /// @notice A local chain's chain id.
    uint256 public constant LOCAL = 31_337;

    /// @notice The only address that can run this contract's restricted functions, fixed for its
    ///         lifetime.
    address public immutable OWNER;

    /// @notice Refuses any chain but the test network or a local one, and fixes the owner.
    /// @param owner_ The owner.
    constructor(address owner_) {
        if (block.chainid != TEST_NETWORK && block.chainid != LOCAL) {
            revert NotATestChain(block.chainid);
        }
        if (owner_ == address(0)) {
            revert ZeroOwner();
        }
        OWNER = owner_;
    }

    /// @notice Refuses every caller but the owner.
    function _requireOwner() internal view {
        if (msg.sender != OWNER) {
            revert NotOwner(msg.sender);
        }
    }
}
