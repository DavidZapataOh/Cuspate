// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {TestOutcomes} from "../unit/PositionVault.t.sol";
import {IOutcomes, PositionVault} from "../../src/PositionVault.sol";

/// @title PositionVaultForkTest
/// @notice Splitting and merging both real collaterals of a market, as they are on the production
///         chain at a pinned block. The underlying calls out to two other contracts on every
///         transfer and the dollar does not; a test token shows neither.
contract PositionVaultForkTest is Test {
    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    address internal holder = makeAddr("holder");

    IERC20 internal underlying;
    IERC20 internal dollar;

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
    }

    /// @notice The underlying splits into eighteen-decimal legs and merges back exactly.
    function testFork_underlyingSplitsAndMergesExactly() public {
        _roundTrip(underlying, 1e17, 18);
    }

    /// @notice The dollar splits into six-decimal legs and merges back exactly.
    function testFork_dollarSplitsAndMergesExactly() public {
        _roundTrip(dollar, 100e6, 6);
    }

    /// @notice Splits and merges one collateral through a fresh vault.
    /// @dev The balance is fabricated with the storage cheatcode. It is not part of any supply the
    ///      token records, and nothing here reads the supply.
    /// @param collateral The real collateral.
    /// @param amount How much to split.
    /// @param expectedDecimals The decimals the collateral reports.
    function _roundTrip(IERC20 collateral, uint256 amount, uint8 expectedDecimals) private {
        PositionVault vault = new PositionVault(
            collateral,
            keccak256("a market"),
            IOutcomes(address(new TestOutcomes())),
            keccak256("a condition"),
            type(uint256).max
        );
        assertEq(vault.YES().decimals(), expectedDecimals);
        deal(address(collateral), holder, amount);

        vm.startPrank(holder);
        collateral.approve(address(vault), amount);
        vault.splitPosition(amount);
        assertEq(collateral.balanceOf(address(vault)), amount);
        vault.mergePositions(amount);
        vm.stopPrank();

        assertEq(collateral.balanceOf(holder), amount);
        assertEq(collateral.balanceOf(address(vault)), 0);
        assertEq(vault.YES().totalSupply(), 0);
    }
}
