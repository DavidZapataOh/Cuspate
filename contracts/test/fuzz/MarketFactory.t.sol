// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {TestCollateral} from "../unit/PositionVault.t.sol";
import {TestStock} from "../unit/MarketFactory.t.sol";

/// @title MarketFactoryFuzzTest
/// @notice Two markets over the same asset with different events never share an id, any of the
///         contracts they create, or any state: operating one leaves the other exactly as it was.
contract MarketFactoryFuzzTest is Test {
    address internal holder = makeAddr("holder");

    address internal resolver = makeAddr("resolver");

    MarketFactory internal factory;
    IERC20 internal underlying;
    IERC20 internal dollar;

    /// @notice A factory and two test collaterals.
    function setUp() public {
        factory = new MarketFactory();
        underlying = IERC20(address(new TestStock()));
        dollar = IERC20(address(new TestCollateral()));
    }

    /// @notice Distinct events give distinct markets, and the twelve contracts they create, two
    ///         vaults and four legs each, are twelve different addresses.
    /// @param eventA One event.
    /// @param eventB Another, made distinct from the first rather than discarded when it is not.
    function testFuzz_distinctInputsCreateDistinctMarkets(bytes32 eventA, bytes32 eventB) public {
        if (eventA == eventB) {
            eventB = bytes32(uint256(eventA) ^ 1);
        }
        bytes32 idA = factory.createMarket(underlying, dollar, eventA, resolver);
        bytes32 idB = factory.createMarket(underlying, dollar, eventB, resolver);
        assertTrue(idA != idB, "two events share a market");

        address[] memory created = new address[](12);
        _collect(idA, created, 0);
        _collect(idB, created, 6);
        for (uint256 i = 0; i < created.length; i++) {
            for (uint256 j = i + 1; j < created.length; j++) {
                assertTrue(created[i] != created[j], "two contracts share an address");
            }
        }
    }

    /// @notice Writes the two vaults and four legs of one market into a list.
    /// @param id The market.
    /// @param into The list.
    /// @param offset Where in the list to start.
    function _collect(bytes32 id, address[] memory into, uint256 offset) private view {
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(id);
        into[offset] = address(underlyingVault);
        into[offset + 1] = address(dollarVault);
        into[offset + 2] = address(underlyingVault.YES());
        into[offset + 3] = address(underlyingVault.NO());
        into[offset + 4] = address(dollarVault.YES());
        into[offset + 5] = address(dollarVault.NO());
    }

    /// @notice Splitting and merging at random in one market leaves every balance and supply of
    ///         another market over the same collaterals exactly as it was.
    /// @param eventA The event of the market operated.
    /// @param eventB The event of the market watched, made distinct rather than discarded.
    /// @param splitAmount How much to split in the market operated.
    /// @param mergeAmount How much of that to merge back.
    function testFuzz_operatingOneMarketLeavesAnotherUntouched(
        bytes32 eventA,
        bytes32 eventB,
        uint256 splitAmount,
        uint256 mergeAmount
    ) public {
        if (eventA == eventB) {
            eventB = bytes32(uint256(eventA) ^ 1);
        }
        bytes32 operated = factory.createMarket(underlying, dollar, eventA, resolver);
        bytes32 watched = factory.createMarket(underlying, dollar, eventB, resolver);
        _operate(watched, 7e6);
        uint256[] memory before = _state(watched);

        splitAmount = bound(splitAmount, 1, 1e30);
        mergeAmount = bound(mergeAmount, 0, splitAmount);
        _operate(operated, splitAmount);
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(operated);
        vm.startPrank(holder);
        underlyingVault.mergePositions(mergeAmount);
        dollarVault.mergePositions(mergeAmount);
        vm.stopPrank();

        assertEq(keccak256(abi.encode(_state(watched))), keccak256(abi.encode(before)));
    }

    /// @notice Splits an amount of both collaterals in both vaults of one market, as the holder.
    /// @param id The market.
    /// @param amount How much of each collateral.
    function _operate(bytes32 id, uint256 amount) private {
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(id);
        TestStock(address(underlying)).mint(holder, amount);
        TestCollateral(address(dollar)).mint(holder, amount);
        vm.startPrank(holder);
        underlying.approve(address(underlyingVault), amount);
        dollar.approve(address(dollarVault), amount);
        underlyingVault.splitPosition(amount);
        dollarVault.splitPosition(amount);
        vm.stopPrank();
    }

    /// @notice Everything observable about one market: each vault's collateral, each leg's supply
    ///         and each leg's balance of the holder.
    /// @param id The market.
    /// @return state The values, in a fixed order.
    function _state(bytes32 id) private view returns (uint256[] memory state) {
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(id);
        PositionVault[2] memory pair = [underlyingVault, dollarVault];
        state = new uint256[](10);
        for (uint256 index = 0; index < 2; index++) {
            PositionVault vault = pair[index];
            state[index * 5] = vault.COLLATERAL().balanceOf(address(vault));
            state[index * 5 + 1] = vault.YES().totalSupply();
            state[index * 5 + 2] = vault.NO().totalSupply();
            state[index * 5 + 3] = vault.YES().balanceOf(holder);
            state[index * 5 + 4] = vault.NO().balanceOf(holder);
        }
    }
}
