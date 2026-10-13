// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";
import {TestCollateral} from "../unit/PositionVault.t.sol";
import {TestStock} from "../unit/MarketFactory.t.sol";

/// @title RedemptionFuzzTest
/// @notice However legs are spread between holders and however the event resolves, what the vault
///         pays out never exceeds what was split into it.
contract RedemptionFuzzTest is Test {
    bytes32 internal constant EVENT = keccak256("an event");

    address internal resolver = makeAddr("resolver");
    address[3] internal holders = [makeAddr("first"), makeAddr("second"), makeAddr("third")];

    MarketFactory internal factory;
    TestCollateral internal dollar;
    PositionVault internal vault;

    /// @notice A market over a test dollar.
    function setUp() public {
        factory = new MarketFactory();
        dollar = new TestCollateral();
        bytes32 id = factory.createMarket(
            IERC20(address(new TestStock())),
            IERC20(address(dollar)),
            EVENT,
            resolver,
            type(uint256).max,
            type(uint256).max
        );
        (, vault) = factory.markets(id);
    }

    /// @notice Split an amount, spread both legs between three holders at random, resolve at random,
    ///         and have everyone redeem everything: the total paid is at most the amount split, exact
    ///         under a yes or a no, and short by at most half a unit per holder under an invalid one.
    /// @param amount How much is split.
    /// @param yesShares How the yes leg is spread.
    /// @param noShares How the no leg is spread.
    /// @param outcomeSeed Chooses the final outcome.
    function testFuzz_payoutsNeverExceedTheCollateral(
        uint256 amount,
        uint256[2] memory yesShares,
        uint256[2] memory noShares,
        uint8 outcomeSeed
    ) public {
        amount = bound(amount, 1, 1e30);
        dollar.mint(holders[0], amount);
        vm.startPrank(holders[0]);
        dollar.approve(address(vault), amount);
        vault.splitPosition(amount);
        vm.stopPrank();
        _spread(vault.YES(), amount, yesShares);
        _spread(vault.NO(), amount, noShares);

        Outcome outcome = Outcome(bound(outcomeSeed, 1, 3));
        vm.prank(resolver);
        factory.reportOutcome(EVENT, outcome);

        uint256 paid;
        for (uint256 index = 0; index < 3; index++) {
            address holder = holders[index];
            uint256 yes = vault.YES().balanceOf(holder);
            uint256 no = vault.NO().balanceOf(holder);
            vm.prank(holder);
            vault.redeemPositions(yes, no);
            paid += dollar.balanceOf(holder);
        }
        assertLe(paid, amount, "the vault paid out more than was split into it");
        // A yes or a no divides nothing, so nothing is lost. An invalid outcome halves, and each of
        // three holders loses at most half a unit: at most one unit in all.
        if (outcome == Outcome.Invalid) {
            assertLe(amount - paid, 1, "rounding cost more than half a unit per holder");
        } else {
            assertEq(paid, amount, "a yes or a no lost something to rounding");
        }
        assertEq(dollar.balanceOf(address(vault)), amount - paid);
    }

    /// @notice Moves parts of the first holder's balance of one leg to the other two.
    /// @param leg The leg.
    /// @param amount The first holder's balance of it.
    /// @param shares Chooses how much goes to each of the other two.
    function _spread(IERC20 leg, uint256 amount, uint256[2] memory shares) private {
        uint256 toSecond = bound(shares[0], 0, amount);
        uint256 toThird = bound(shares[1], 0, amount - toSecond);
        vm.startPrank(holders[0]);
        assertTrue(leg.transfer(holders[1], toSecond));
        assertTrue(leg.transfer(holders[2], toThird));
        vm.stopPrank();
    }
}
