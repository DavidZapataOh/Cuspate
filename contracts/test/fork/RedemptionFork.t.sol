// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";

/// @title RedemptionForkTest
/// @notice A market over both real collaterals, resolved each way and redeemed, as the tokens are on
///         the production chain at a pinned block.
contract RedemptionForkTest is Test {
    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    bytes32 internal constant EVENT = keccak256("an event");

    address internal resolver = makeAddr("resolver");
    address internal holder = makeAddr("holder");

    IERC20 internal underlying;
    IERC20 internal dollar;
    MarketFactory internal factory;

    /// @notice Opens on a fork at the pinned block and proves both collaterals are there.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);

        underlying = IERC20(AddressBook.thirdParty("collateral", 0));
        dollar = IERC20(AddressBook.thirdParty("dollar", 0));
        assertEq(block.chainid, PRODUCTION_CHAIN, "not on a fork of the production chain");
        assertEq(block.number, pinned, "not at the pinned block");
        assertGt(
            address(underlying).code.length * address(dollar).code.length,
            0,
            "no code at a recorded collateral at the pinned block: if the endpoint no longer "
            "serves this block, re-pin it; the assertion itself is not what failed"
        );
        factory = new MarketFactory();
    }

    /// @notice A yes pays the holder of both legs the full split, in both real collaterals.
    function testFork_aYesRedeemsInBothRealCollaterals() public {
        _resolveAndRedeem(Outcome.Yes);
    }

    /// @notice An invalid outcome pays half of each leg, in both real collaterals.
    function testFork_anInvalidOutcomeRedeemsInBothRealCollaterals() public {
        _resolveAndRedeem(Outcome.Invalid);
    }

    /// @notice Splits in both vaults, reports the outcome, and redeems everything back.
    /// @dev The balances are fabricated with the storage cheatcode; nothing here reads the supply.
    /// @param outcome The outcome to report.
    function _resolveAndRedeem(Outcome outcome) private {
        bytes32 id = factory.createMarket(underlying, dollar, EVENT, resolver);
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(id);
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        uint256[2] memory amounts = [uint256(1e17), uint256(100e6)];

        for (uint256 index = 0; index < 2; index++) {
            IERC20 collateral = vaults[index].COLLATERAL();
            deal(address(collateral), holder, amounts[index]);
            vm.startPrank(holder);
            collateral.approve(address(vaults[index]), amounts[index]);
            vaults[index].splitPosition(amounts[index]);
            vm.stopPrank();
        }

        vm.prank(resolver);
        factory.reportOutcome(EVENT, outcome);

        for (uint256 index = 0; index < 2; index++) {
            IERC20 collateral = vaults[index].COLLATERAL();
            vm.prank(holder);
            vaults[index].redeemPositions(amounts[index], amounts[index]);
            assertEq(collateral.balanceOf(holder), amounts[index], "a full set did not pay in full");
            assertEq(collateral.balanceOf(address(vaults[index])), 0);
        }
    }
}
