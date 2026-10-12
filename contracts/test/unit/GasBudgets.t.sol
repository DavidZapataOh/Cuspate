// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";
import {TestCollateral} from "./PositionVault.t.sol";
import {TestStock} from "./MarketFactory.t.sol";

/// @title GasCases
/// @notice Every entry point a user or a pool calls, performed as its own transaction in the worst
///         case a user can meet and in the steady case most meet, and recorded under
///         `<Contract>.<function> <case>`. Each worst case is checked before the call, so a change to
///         the fixture cannot quietly turn it into a cheaper one.
/// @dev Recorded under isolation, so each value is receipt gas: intrinsic cost and calldata included.
abstract contract GasCases is Test {
    bytes32 internal constant EVENT = keccak256("an event");

    address internal resolver = makeAddr("resolver");

    MarketFactory internal factory;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;

    /// @notice The file the values are recorded in.
    /// @return The group.
    function _group() internal pure virtual returns (string memory);

    /// @notice The two collaterals the market is created over.
    /// @return underlying The underlying.
    /// @return dollar The dollar.
    function _collaterals() internal virtual returns (IERC20 underlying, IERC20 dollar);

    /// @notice A market over the two collaterals.
    function setUp() public virtual {
        (IERC20 underlying, IERC20 dollar) = _collaterals();
        factory = new MarketFactory();
        (underlyingVault, dollarVault) =
            factory.markets(factory.createMarket(underlying, dollar, EVENT, resolver));
    }

    /// @notice Creating a market: two vaults and four legs, at the collaterals' symbol lengths.
    function test_createMarket() public {
        IERC20 underlying = underlyingVault.COLLATERAL();
        IERC20 dollar = dollarVault.COLLATERAL();
        string memory symbols = string.concat(
            IERC20Metadata(address(underlying)).symbol(),
            " and ",
            IERC20Metadata(address(dollar)).symbol()
        );
        factory.createMarket(underlying, dollar, keccak256("another event"), resolver);
        _record("MarketFactory.createMarket over ", symbols);
    }

    /// @notice A resolver's first report of a condition.
    function test_reportOutcome() public {
        assertEq(uint8(factory.outcomeOf(underlyingVault.CONDITION())), uint8(Outcome.Unresolved));
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);
        _record("MarketFactory.reportOutcome first report of a condition", "");
    }

    /// @notice The first split in a vault, by a holder with no legs and an exact allowance; then a
    ///         further split by the same holder.
    function test_splitPosition() public {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        for (uint256 index = 0; index < 2; index++) {
            PositionVault vault = vaults[index];
            string memory name = _name(vault);
            IERC20 collateral = vault.COLLATERAL();
            uint256 amount = _amount(vault);
            address holder = makeAddr(string.concat("splitter ", name));
            _fund(vault, holder, 2 * amount);
            vm.prank(holder);
            collateral.approve(address(vault), amount);

            assertEq(vault.YES().totalSupply() + vault.NO().totalSupply(), 0);
            assertEq(vault.YES().balanceOf(holder) + vault.NO().balanceOf(holder), 0);
            assertEq(collateral.balanceOf(address(vault)), 0);
            assertEq(collateral.allowance(holder, address(vault)), amount);
            vm.prank(holder);
            vault.splitPosition(amount);
            _record("PositionVault.splitPosition first in the vault, exact allowance, ", name);

            vm.prank(holder);
            collateral.approve(address(vault), amount);
            vm.prank(holder);
            vault.splitPosition(amount);
            _record("PositionVault.splitPosition again by the same holder, exact allowance, ", name);
        }
    }

    /// @notice Everything back to a holder left with no collateral; then part back to a holder with
    ///         a balance.
    function test_mergePositions() public {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        for (uint256 index = 0; index < 2; index++) {
            PositionVault vault = vaults[index];
            string memory name = _name(vault);
            uint256 amount = _amount(vault);
            address emptied = _split(vault, "emptied", amount, amount);
            address holding = _split(vault, "holding", 2 * amount, amount);

            assertEq(vault.COLLATERAL().balanceOf(emptied), 0);
            vm.prank(emptied);
            vault.mergePositions(amount);
            _record(
                "PositionVault.mergePositions everything, to a holder with no collateral, ", name
            );

            vm.prank(holding);
            vault.mergePositions(amount / 2);
            _record("PositionVault.mergePositions part, to a holder with collateral, ", name);
        }
    }

    /// @notice Both legs to a holder with no collateral; then the winning leg alone to a holder with
    ///         a balance.
    function test_redeemPositions() public {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        address[2] memory emptied;
        address[2] memory holding;
        for (uint256 index = 0; index < 2; index++) {
            uint256 amount = _amount(vaults[index]);
            emptied[index] = _split(vaults[index], "redeemer, emptied", amount, amount);
            holding[index] = _split(vaults[index], "redeemer, holding", 2 * amount, amount);
        }
        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);

        for (uint256 index = 0; index < 2; index++) {
            PositionVault vault = vaults[index];
            string memory name = _name(vault);
            uint256 amount = _amount(vault);
            assertEq(vault.COLLATERAL().balanceOf(emptied[index]), 0);
            vm.prank(emptied[index]);
            vault.redeemPositions(amount, amount);
            _record(
                "PositionVault.redeemPositions both legs, to a holder with no collateral, ", name
            );

            vm.prank(holding[index]);
            vault.redeemPositions(amount, 0);
            _record(
                "PositionVault.redeemPositions the winning leg, to a holder with collateral, ", name
            );
        }
    }

    /// @notice A leg moved by its holder, by a spender, and an allowance granted.
    function test_legs() public {
        uint256 amount = _amount(underlyingVault);
        address holder = _split(underlyingVault, "leg holder", amount, amount);
        IERC20 leg = underlyingVault.YES();
        address stranger = makeAddr("no legs");
        address other = makeAddr("another holder");
        address spender = makeAddr("spender");
        address unlimited = makeAddr("unlimited spender");

        assertEq(leg.balanceOf(stranger), 0);
        vm.prank(holder);
        leg.transfer(stranger, amount / 8);
        _record("PositionToken.transfer to an address with no legs", "");

        vm.prank(holder);
        leg.transfer(stranger, amount / 8);
        _record("PositionToken.transfer to a holder", "");

        assertEq(leg.allowance(holder, spender), 0);
        vm.prank(holder);
        leg.approve(spender, amount / 8);
        _record("PositionToken.approve a fresh allowance", "");

        assertEq(leg.balanceOf(other), 0);
        vm.prank(spender);
        leg.transferFrom(holder, other, amount / 8);
        _record("PositionToken.transferFrom exact allowance, to an address with no legs", "");

        vm.prank(holder);
        leg.approve(unlimited, type(uint256).max);
        vm.prank(unlimited);
        leg.transferFrom(holder, other, amount / 8);
        _record("PositionToken.transferFrom unlimited allowance, to a holder", "");
    }

    /// @notice A holder who has split into a vault.
    /// @param vault The vault.
    /// @param label Names the holder.
    /// @param funded How much collateral the holder starts with.
    /// @param amount How much the holder splits.
    /// @return holder The holder.
    function _split(PositionVault vault, string memory label, uint256 funded, uint256 amount)
        internal
        returns (address holder)
    {
        holder = makeAddr(string.concat(label, " ", _name(vault)));
        _fund(vault, holder, funded);
        vm.startPrank(holder);
        vault.COLLATERAL().approve(address(vault), amount);
        vault.splitPosition(amount);
        vm.stopPrank();
    }

    /// @notice Gives an account collateral.
    /// @dev The balance is fabricated with the storage cheatcode; nothing here reads the supply.
    /// @param vault The vault whose collateral to give.
    /// @param to The account.
    /// @param amount How much.
    function _fund(PositionVault vault, address to, uint256 amount) internal {
        deal(address(vault.COLLATERAL()), to, amount);
    }

    /// @notice One whole unit of a vault's collateral.
    /// @param vault The vault.
    /// @return The amount.
    function _amount(PositionVault vault) internal view returns (uint256) {
        return 10 ** IERC20Metadata(address(vault.COLLATERAL())).decimals();
    }

    /// @notice A vault's collateral by symbol.
    /// @param vault The vault.
    /// @return The symbol.
    function _name(PositionVault vault) internal view returns (string memory) {
        return IERC20Metadata(address(vault.COLLATERAL())).symbol();
    }

    /// @notice Records the last call's gas under a case.
    /// @dev Makes no call of its own: everything it records is computed before the measured call.
    /// @param case_ The case.
    /// @param suffix Appended to it.
    function _record(string memory case_, string memory suffix) internal {
        vm.snapshotGasLastFrame(_group(), string.concat(case_, suffix));
    }
}

/// @title GasBudgetsTest
/// @notice The cases over test collaterals: regression budgets for this repository's own code.
contract GasBudgetsTest is GasCases {
    /// @notice The file the values are recorded in.
    /// @return The group: budgets.
    function _group() internal pure override returns (string memory) {
        return "budgets";
    }

    /// @notice The two collaterals the market is created over.
    /// @return The underlying.
    /// @return The dollar.
    function _collaterals() internal override returns (IERC20, IERC20) {
        return (IERC20(address(new TestStock())), IERC20(address(new TestCollateral())));
    }
}
