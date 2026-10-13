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

    /// @notice Thrown when a market is created with a cap of zero, which nobody could enter.
    error ZeroCap();

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
    /// @param underlyingCap The most underlying the market holds outstanding.
    /// @param dollarCap The most dollar the market holds outstanding.
    event MarketCreated(
        bytes32 indexed marketId,
        IERC20 indexed underlying,
        IERC20 indexed dollar,
        bytes32 eventId,
        address resolver,
        PositionVault underlyingVault,
        PositionVault dollarVault,
        uint256 underlyingCap,
        uint256 dollarCap
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
    /// @param underlyingCap The most underlying it holds outstanding.
    /// @param dollarCap The most dollar it holds outstanding.
    /// @return The market's id.
    function marketId(
        IERC20 underlying,
        IERC20 dollar,
        bytes32 condition_,
        uint256 underlyingCap,
        uint256 dollarCap
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(underlying, dollar, condition_, underlyingCap, dollarCap));
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
    /// @custom:access anyone
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
    /// @param underlyingCap The most underlying the market holds outstanding at once. Part of the id
    ///        too, for the same reason; raising it means creating another market.
    /// @param dollarCap The most dollar the market holds outstanding at once; likewise.
    /// @return id The new market's id.
    /// @custom:access anyone
    function createMarket(
        IERC20 underlying,
        IERC20 dollar,
        bytes32 eventId,
        address resolver,
        uint256 underlyingCap,
        uint256 dollarCap
    ) external returns (bytes32 id) {
        if (underlying == dollar) {
            revert SameCollateral(dollar);
        }
        if (resolver == address(0)) {
            revert ZeroResolver();
        }
        if (underlyingCap == 0 || dollarCap == 0) {
            revert ZeroCap();
        }
        bytes32 marketCondition = condition(resolver, eventId);
        id = marketId(underlying, dollar, marketCondition, underlyingCap, dollarCap);
        if (address(markets[id].underlyingVault) != address(0)) {
            revert MarketExists(id);
        }

        // A vault's creation code depends only on these inputs, so both addresses are known before
        // anything exists, and the market is recorded and announced before any call is made.
        bytes memory underlyingCode = _vaultCode(underlying, id, marketCondition, underlyingCap);
        bytes memory dollarCode = _vaultCode(dollar, id, marketCondition, dollarCap);
        PositionVault underlyingVault = PositionVault(_created(id, keccak256(underlyingCode)));
        PositionVault dollarVault = PositionVault(_created(id, keccak256(dollarCode)));
        markets[id] = Market(underlyingVault, dollarVault);
        emit MarketCreated(
            id,
            underlying,
            dollar,
            eventId,
            resolver,
            underlyingVault,
            dollarVault,
            underlyingCap,
            dollarCap
        );
        Create2.deploy(0, id, underlyingCode);
        Create2.deploy(0, id, dollarCode);
    }

    /// @notice The creation code of the vault over one collateral in one market, which reads its
    ///         outcome from this factory.
    /// @param collateral The collateral.
    /// @param id The market's id, which is also the salt the vault is created under.
    /// @param marketCondition The condition the market is conditioned on.
    /// @param cap The vault's cap.
    /// @return The vault's creation code, with its constructor arguments.
    function _vaultCode(IERC20 collateral, bytes32 id, bytes32 marketCondition, uint256 cap)
        private
        view
        returns (bytes memory)
    {
        return bytes.concat(
            type(PositionVault).creationCode,
            abi.encode(collateral, id, IOutcomes(address(this)), marketCondition, cap)
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
