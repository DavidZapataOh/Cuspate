// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// @title TestnetStockOracle
/// @notice The test network's price feed for the test stocks, read through the same function as
///         the production feed. Its owner publishes; every round it publishes is a regular-session
///         round written at the block that carries it.
contract TestnetStockOracle is TestnetOnly {
    /// @notice Thrown when a symbol has never been published.
    /// @param priceId The symbol's id.
    error PriceNotAvailable(bytes32 priceId);

    /// @notice One symbol's price, as the publisher posts it.
    /// @param priceId The keccak256 of the upper-case symbol.
    /// @param price The price, 8 decimals.
    /// @param bestBid The best bid, 8 decimals.
    /// @param bestAsk The best ask, 8 decimals.
    /// @param feedUpdateTimestamp When the source feed last changed.
    struct Post {
        bytes32 priceId;
        int128 price;
        int128 bestBid;
        int128 bestAsk;
        uint64 feedUpdateTimestamp;
    }

    /// @notice A stored round.
    /// @param price The price, 8 decimals.
    /// @param bestBid The best bid, 8 decimals.
    /// @param bestAsk The best ask, 8 decimals.
    /// @param feedUpdateTimestamp When the source feed last changed.
    /// @param publishedAt When the round was written.
    /// @param roundId The round.
    struct Round {
        int128 price;
        int128 bestBid;
        int128 bestAsk;
        uint64 feedUpdateTimestamp;
        uint64 publishedAt;
        uint80 roundId;
    }

    /// @notice The regular session, the only one this feed reports.
    uint8 public constant REGULAR = 2;

    mapping(bytes32 priceId => Round round) private rounds;

    /// @notice Creates the feed with its publisher.
    /// @param publisher The owner, who publishes.
    constructor(address publisher) TestnetOnly(publisher) {}

    /// @notice Publishes one round for each symbol posted.
    /// @param posts The prices.
    /// @custom:access owner
    function post(Post[] calldata posts) external {
        _requireOwner();
        for (uint256 i = 0; i < posts.length; ++i) {
            Post calldata p = posts[i];
            Round storage round = rounds[p.priceId];
            round.price = p.price;
            round.bestBid = p.bestBid;
            round.bestAsk = p.bestAsk;
            round.feedUpdateTimestamp = p.feedUpdateTimestamp;
            round.publishedAt = SafeCast.toUint64(block.timestamp);
            round.roundId += 1;
        }
    }

    /// @notice The latest round for a symbol's id.
    /// @param priceId The keccak256 of the upper-case symbol.
    /// @return price The price, 8 decimals.
    /// @return bestBid The best bid, 8 decimals.
    /// @return bestAsk The best ask, 8 decimals.
    /// @return feedUpdateTimestamp When the source feed last changed.
    /// @return publishedAt When the round was written.
    /// @return roundId The round.
    /// @return session Always the regular session.
    function latestPrice(bytes32 priceId)
        external
        view
        returns (
            int128 price,
            int128 bestBid,
            int128 bestAsk,
            uint64 feedUpdateTimestamp,
            uint64 publishedAt,
            uint80 roundId,
            uint8 session
        )
    {
        Round storage round = rounds[priceId];
        if (round.roundId == 0) {
            revert PriceNotAvailable(priceId);
        }
        return (
            round.price,
            round.bestBid,
            round.bestAsk,
            round.feedUpdateTimestamp,
            round.publishedAt,
            round.roundId,
            REGULAR
        );
    }
}
