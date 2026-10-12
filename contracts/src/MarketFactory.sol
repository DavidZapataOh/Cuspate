// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IOutcomes, Outcome, PositionVault} from "./PositionVault.sol";

/// @title MarketFactory
/// @notice Creates markets, permissionlessly, and is where their outcomes are reported. A market is
///         one condition over an underlying and a dollar, so it is two vaults and four legs, created
///         together. A condition is a resolver and an event; its outcome is reported once, by that
///         resolver, and every market over it reads the same one.
contract MarketFactory is IOutcomes {
    /// @notice Thrown when a market with the same inputs already exists.
    /// @param marketId The existing market.
    error MarketExists(bytes32 marketId);

    /// @notice Thrown when both collaterals of a market are the same token.
    /// @param collateral The token given twice.
    error SameCollateral(IERC20 collateral);

    /// @notice Thrown when a condition's outcome has already been reported.
    /// @param condition The condition.
    error OutcomeAlreadyReported(bytes32 condition);

    /// @notice Thrown when the outcome reported is not a final one.
    error OutcomeNotFinal();

    /// @notice Thrown when a market is created with no resolver, so that nothing could ever resolve it.
    error ZeroResolver();

    /// @notice Emitted when a condition's outcome is reported.
    /// @param condition The condition.
    /// @param resolver Who reported it, which is the resolver the condition names.
    /// @param eventId The event.
    /// @param outcome The outcome.
    event OutcomeReported(
        bytes32 indexed condition,
        address indexed resolver,
        bytes32 indexed eventId,
        Outcome outcome
    );

    /// @notice Emitted when a market is created.
    /// @param marketId The market's id.
    /// @param underlying The underlying it splits.
    /// @param dollar The dollar it splits.
    /// @param eventId The event it is conditioned on.
    /// @param resolver Who reports the event's outcome for this market.
    /// @param underlyingVault The vault over the underlying.
    /// @param dollarVault The vault over the dollar.
    event MarketCreated(
        bytes32 indexed marketId,
        IERC20 indexed underlying,
        IERC20 indexed dollar,
        bytes32 eventId,
        address resolver,
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

    mapping(bytes32 condition => Outcome outcome) internal outcomes;

    /// @notice The condition of an event as a given resolver reports it.
    /// @param resolver Who reports the outcome.
    /// @param eventId The event.
    /// @return The condition.
    function condition(address resolver, bytes32 eventId) public pure returns (bytes32) {
        return keccak256(abi.encode(resolver, eventId));
    }

    /// @notice The id of the market over these inputs, whether or not it exists.
    /// @param underlying The underlying it splits.
    /// @param dollar The dollar it splits.
    /// @param condition_ The condition it is conditioned on.
    /// @return The market's id.
    function marketId(IERC20 underlying, IERC20 dollar, bytes32 condition_)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(underlying, dollar, condition_));
    }

    /// @inheritdoc IOutcomes
    function outcomeOf(bytes32 condition_) external view returns (Outcome) {
        return outcomes[condition_];
    }

    /// @notice Reports the final outcome of an event, as the caller resolves it. It lands under the
    ///         condition whose resolver is the caller, and nowhere else, so nobody can report for a
    ///         condition that is not theirs. It is written once.
    /// @param eventId The event.
    /// @param outcome Its final outcome.
    function reportOutcome(bytes32 eventId, Outcome outcome) external {
        if (outcome == Outcome.Unresolved) {
            revert OutcomeNotFinal();
        }
        bytes32 reported = condition(msg.sender, eventId);
        if (outcomes[reported] != Outcome.Unresolved) {
            revert OutcomeAlreadyReported(reported);
        }
        outcomes[reported] = outcome;
        emit OutcomeReported(reported, msg.sender, eventId, outcome);
    }

    /// @notice Creates the market over these inputs: a vault for each collateral, each with its two
    ///         legs.
    /// @param underlying The underlying it splits.
    /// @param dollar The dollar it splits.
    /// @param eventId The event it is conditioned on.
    /// @param resolver Who reports the event's outcome for this market. It is part of the market's
    ///        id, so a market's resolver is never chosen by whoever happens to create it first.
    /// @return id The new market's id.
    function createMarket(IERC20 underlying, IERC20 dollar, bytes32 eventId, address resolver)
        external
        returns (bytes32 id)
    {
        if (underlying == dollar) {
            revert SameCollateral(dollar);
        }
        if (resolver == address(0)) {
            revert ZeroResolver();
        }
        bytes32 marketCondition = condition(resolver, eventId);
        id = marketId(underlying, dollar, marketCondition);
        if (address(markets[id].underlyingVault) != address(0)) {
            revert MarketExists(id);
        }

        // A vault's creation code depends only on these inputs, so both addresses are known before
        // anything exists, and the market is recorded and announced before any call is made.
        bytes memory underlyingCode = _vaultCode(underlying, id, marketCondition);
        bytes memory dollarCode = _vaultCode(dollar, id, marketCondition);
        PositionVault underlyingVault = PositionVault(_created(id, keccak256(underlyingCode)));
        PositionVault dollarVault = PositionVault(_created(id, keccak256(dollarCode)));
        markets[id] = Market(underlyingVault, dollarVault);
        emit MarketCreated(id, underlying, dollar, eventId, resolver, underlyingVault, dollarVault);
        Create2.deploy(0, id, underlyingCode);
        Create2.deploy(0, id, dollarCode);
    }

    /// @notice The creation code of the vault over one collateral in one market, which reads its
    ///         outcome from this factory.
    /// @param collateral The collateral.
    /// @param id The market's id, which is also the salt the vault is created under.
    /// @param marketCondition The condition the market is conditioned on.
    /// @return The vault's creation code, with its constructor arguments.
    function _vaultCode(IERC20 collateral, bytes32 id, bytes32 marketCondition)
        private
        view
        returns (bytes memory)
    {
        return bytes.concat(
            type(PositionVault).creationCode,
            abi.encode(collateral, id, IOutcomes(address(this)), marketCondition)
        );
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
