// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {PositionVault} from "../../src/PositionVault.sol";

/// @title MarketFactoryForkTest
/// @notice A market over both real collaterals, as they are on the production chain at a pinned
///         block, created and operated through its two vaults.
contract MarketFactoryForkTest is Test {
    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    address internal holder = makeAddr("holder");

    IERC20 internal underlying;
    IERC20 internal dollar;
    address internal resolver = makeAddr("resolver");

    MarketFactory internal factory;

    /// @notice Opens on a fork at the pinned block, proves both collaterals are there, and deploys
    ///         a factory.
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

    /// @notice A market over both real collaterals names its legs after them and splits and merges
    ///         in both vaults.
    function testFork_aMarketOverBothRealCollateralsSplitsAndMerges() public {
        bytes32 id = factory.createMarket(
            underlying,
            dollar,
            keccak256("an event"),
            resolver,
            type(uint256).max,
            type(uint256).max
        );
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(id);

        assertEq(underlyingVault.YES().symbol(), "aMU-YES");
        assertEq(dollarVault.NO().symbol(), "USDC-NO");
        assertEq(underlyingVault.YES().decimals(), 18);
        assertEq(dollarVault.YES().decimals(), 6);

        _roundTrip(underlyingVault, 1e17);
        _roundTrip(dollarVault, 100e6);
    }

    /// @notice Splits and merges an amount through one vault and checks it came back whole.
    /// @dev The balance is fabricated with the storage cheatcode; nothing here reads the supply.
    /// @param vault The vault.
    /// @param amount How much.
    function _roundTrip(PositionVault vault, uint256 amount) private {
        IERC20 collateral = vault.COLLATERAL();
        deal(address(collateral), holder, amount);
        vm.startPrank(holder);
        collateral.approve(address(vault), amount);
        vault.splitPosition(amount);
        vault.mergePositions(amount);
        vm.stopPrank();
        assertEq(collateral.balanceOf(holder), amount);
        assertEq(collateral.balanceOf(address(vault)), 0);
    }
}
