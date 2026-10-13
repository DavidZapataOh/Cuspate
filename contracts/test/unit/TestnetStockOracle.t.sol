// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestnetStockOracle} from "../../src/testnet/TestnetStockOracle.sol";
import {TestnetOnly} from "../../src/testnet/TestnetOnly.sol";

/// @title TestnetStockOracleTest
/// @notice The test network's price feed: read as the production feed is, written only by its
///         publisher.
contract TestnetStockOracleTest is Test {
    address internal constant PUBLISHER = address(0xA11CE);
    address internal constant OTHER = address(0xB0B);
    bytes32 internal constant TSLA = keccak256("TSLA");
    bytes32 internal constant AAPL = keccak256("AAPL");

    TestnetStockOracle internal oracle;

    /// @notice The feed, on the test network's chain id, at a realistic time.
    function setUp() public {
        vm.chainId(10_143);
        vm.warp(1_790_000_000);
        oracle = new TestnetStockOracle(PUBLISHER);
    }

    /// @notice Two symbols' prices, as the publisher posts them.
    /// @return posts The prices.
    function _rounds() internal view returns (TestnetStockOracle.Post[] memory posts) {
        posts = new TestnetStockOracle.Post[](2);
        posts[0] = TestnetStockOracle.Post({
            priceId: TSLA,
            price: 412_50000000,
            bestBid: 412_40000000,
            bestAsk: 412_60000000,
            feedUpdateTimestamp: uint64(vm.getBlockTimestamp() - 3)
        });
        posts[1] = TestnetStockOracle.Post({
            priceId: AAPL,
            price: 251_10000000,
            bestBid: 251_00000000,
            bestAsk: 251_20000000,
            feedUpdateTimestamp: uint64(vm.getBlockTimestamp() - 5)
        });
    }

    /// @notice A posted price reads back as a regular-session round written at its block.
    function test_aPostedPriceIsReadAsARegularSessionRound() public {
        vm.prank(PUBLISHER);
        oracle.post(_rounds());
        (
            int128 price,
            int128 bid,
            int128 ask,
            uint64 updated,
            uint64 published,
            uint80 round,
            uint8 session
        ) = oracle.latestPrice(TSLA);
        assertEq(price, 412_50000000);
        assertEq(bid, 412_40000000);
        assertEq(ask, 412_60000000);
        assertEq(updated, vm.getBlockTimestamp() - 3);
        assertEq(published, vm.getBlockTimestamp());
        assertEq(round, 1);
        assertEq(session, 2);
        (price,,,,, round,) = oracle.latestPrice(AAPL);
        assertEq(price, 251_10000000);
        assertEq(round, 1);
    }

    /// @notice Every post is a new round.
    function test_eachPostIsANewRound() public {
        vm.startPrank(PUBLISHER);
        oracle.post(_rounds());
        oracle.post(_rounds());
        vm.stopPrank();
        (,,,,, uint80 round,) = oracle.latestPrice(TSLA);
        assertEq(round, 2);
    }

    /// @notice A symbol never posted has no price, as on the production feed.
    function test_RevertWhen_aSymbolWasNeverPosted() public {
        vm.expectRevert(abi.encodeWithSelector(TestnetStockOracle.PriceNotAvailable.selector, TSLA));
        oracle.latestPrice(TSLA);
    }

    /// @notice Only the publisher posts.
    function test_RevertWhen_postCallerIsNotThePublisher() public {
        TestnetStockOracle.Post[] memory posts = _rounds();
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.NotOwner.selector, OTHER));
        vm.prank(OTHER);
        oracle.post(posts);
    }

    /// @notice The feed cannot be created on the production chain.
    function test_RevertWhen_deployedOnAnotherChain() public {
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.NotATestChain.selector, 143));
        new TestnetStockOracle(PUBLISHER);
    }
}
