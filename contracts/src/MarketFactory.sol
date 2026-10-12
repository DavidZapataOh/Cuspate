// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {PositionVault} from "./PositionVault.sol";

/// @title MarketFactory
/// @notice Creates markets, permissionlessly. A market is one event over an underlying and a dollar,
///         so it is two vaults and four legs, created together. Its id is a hash of exactly those
///         three inputs, and no id is ever created twice.
contract MarketFactory {
    /// @notice Thrown when a market with the same inputs already exists.
    /// @param marketId The existing market.
    error MarketExists(bytes32 marketId);

    /// @notice Thrown when both collaterals of a market are the same token.
    /// @param collateral The token given twice.
    error SameCollateral(IERC20 collateral);

    /// @notice Emitted when a market is created.
    /// @param marketId The market's id.
    /// @param underlying The underlying it splits.
    /// @param dollar The dollar it splits.
    /// @param eventId The event it is conditioned on.
    /// @param underlyingVault The vault over the underlying.
    /// @param dollarVault The vault over the dollar.
    event MarketCreated(
        bytes32 indexed marketId,
        IERC20 indexed underlying,
        IERC20 indexed dollar,
        bytes32 eventId,
        PositionVault underlyingVault,
        PositionVault dollarVault
    );

    /// @notice The two vaults of one market.
    /// @param underlyingVault The vault over the underlying.
    /// @param dollarVault The vault over the dollar.
    struct Market {
        PositionVault underlyingVault;
        PositionVault dollarVault;
    }

    /// @notice Every market created, by id. Each entry is written once and never changed.
    mapping(bytes32 marketId => Market market) public markets;

    /// @notice The id of the market over these inputs, whether or not it exists.
    /// @param underlying The underlying it splits.
    /// @param dollar The dollar it splits.
    /// @param eventId The event it is conditioned on.
    /// @return The market's id.
    function marketId(IERC20 underlying, IERC20 dollar, bytes32 eventId)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(underlying, dollar, eventId));
    }

    /// @notice Creates the market over these inputs: a vault for each collateral, each with its two
    ///         legs.
    /// @param underlying The underlying it splits.
    /// @param dollar The dollar it splits.
    /// @param eventId The event it is conditioned on.
    /// @return id The new market's id.
    function createMarket(IERC20 underlying, IERC20 dollar, bytes32 eventId)
        external
        returns (bytes32 id)
    {
        if (underlying == dollar) {
            revert SameCollateral(dollar);
        }
        id = marketId(underlying, dollar, eventId);
        if (address(markets[id].underlyingVault) != address(0)) {
            revert MarketExists(id);
        }

        // A vault's creation code depends only on these inputs, so both addresses are known before
        // anything exists, and the market is recorded and announced before any call is made.
        bytes memory underlyingCode = _vaultCode(underlying, id);
        bytes memory dollarCode = _vaultCode(dollar, id);
        PositionVault underlyingVault = PositionVault(_created(id, keccak256(underlyingCode)));
        PositionVault dollarVault = PositionVault(_created(id, keccak256(dollarCode)));
        markets[id] = Market(underlyingVault, dollarVault);
        emit MarketCreated(id, underlying, dollar, eventId, underlyingVault, dollarVault);
        Create2.deploy(0, id, underlyingCode);
        Create2.deploy(0, id, dollarCode);
    }

    /// @notice The creation code of the vault over one collateral in one market.
    /// @param collateral The collateral.
    /// @param id The market's id, which is also the salt the vault is created under.
    /// @return The vault's creation code, with its constructor arguments.
    function _vaultCode(IERC20 collateral, bytes32 id) private pure returns (bytes memory) {
        return bytes.concat(type(PositionVault).creationCode, abi.encode(collateral, id));
    }

    /// @notice The address a contract with this creation code takes when this factory creates it
    ///         under this salt: the last twenty bytes of the hash of 0xff, this factory, the salt
    ///         and the code's hash.
    /// @dev Written without the standard library's helper, without assembly and without a
    ///      narrowing cast, because the analyser refuses each of those ahead of an event: it reads
    ///      the helper and any assembly as possible external calls, and the cast as a truncation.
    ///      Masking to twenty bytes and decoding as an address states the truncation as intended,
    ///      and the decoder refuses any value that does not fit rather than silently cutting it.
    /// @param salt The salt.
    /// @param codeHash The hash of the creation code, with its constructor arguments.
    /// @return The address.
    function _created(bytes32 salt, bytes32 codeHash) private view returns (address) {
        uint256 hash =
            uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)));
        return abi.decode(abi.encode(hash & type(uint160).max), (address));
    }
}
