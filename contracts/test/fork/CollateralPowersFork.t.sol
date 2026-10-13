// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";

/// @notice The underlying's links to the contracts that govern it.
interface IGovernedStock {
    /// @notice The factory that registered the token and holds its pause.
    /// @return The factory.
    function FACTORY() external view returns (address);

    /// @notice The module that keeps the denylist.
    /// @return The module.
    function COMPLIANCE() external view returns (address);
}

/// @notice The underlying's factory, as far as its per-token pause.
interface IStockFactory {
    /// @notice The role allowed to pause a token's transfers.
    /// @return The role.
    function TOKEN_PAUSE_ROLE() external view returns (bytes32);

    /// @notice A holder of a role.
    /// @param role The role.
    /// @param index Which holder.
    /// @return The holder.
    function getRoleMember(bytes32 role, uint256 index) external view returns (address);
}

/// @notice The underlying's denylist.
interface IDenylist {
    /// @notice Blocks every transfer from and to each account.
    /// @param accounts The accounts.
    function addToDenylist(address[] calldata accounts) external;

    /// @notice Lifts the block on each account.
    /// @param accounts The accounts.
    function removeFromDenylist(address[] calldata accounts) external;

    /// @notice A holder of a role.
    /// @param role The role.
    /// @param index Which holder.
    /// @return The holder.
    function getRoleMember(bytes32 role, uint256 index) external view returns (address);
}

/// @notice The dollar's pause and blacklist.
interface IFiatToken {
    /// @notice Who may pause.
    /// @return The pauser.
    function pauser() external view returns (address);

    /// @notice Who may blacklist.
    /// @return The blacklister.
    function blacklister() external view returns (address);

    /// @notice Stops every transfer.
    function pause() external;

    /// @notice Resumes transfers.
    function unpause() external;

    /// @notice Blocks every transfer from and to an account.
    /// @param account The account.
    function blacklist(address account) external;

    /// @notice Lifts the block on an account.
    /// @param account The account.
    function unBlacklist(address account) external;
}

/// @title CollateralPowersForkTest
/// @notice What each issuer's power over a collateral does to a vault holding it: it freezes the
///         vault's split, merge and redemption, and once lifted leaves every unit redeemable.
///         Every power is used by the address that holds it on the production chain at the pinned
///         block, read from the chain.
contract CollateralPowersForkTest is Test {
    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    /// @notice The underlying factory's per-token transfer pause, `(address token, bool paused)`.
    /// @dev Measured, not published: called with true by the holder of `TOKEN_PAUSE_ROLE`, the
    ///      token's transfers revert `TransferPaused()`; called with false, they resume.
    bytes4 internal constant SET_TRANSFERS_PAUSED = 0x31a05113;

    /// @notice The compliance module's getter for the role that adds to the denylist. Measured.
    bytes4 internal constant DENYLIST_ADDER_ROLE = 0xd35906ef;

    /// @notice The compliance module's getter for the role that removes from it. Measured.
    bytes4 internal constant DENYLIST_REMOVER_ROLE = 0x1f148608;

    /// @notice The underlying's revert while its transfers are paused: `TransferPaused()`.
    bytes4 internal constant TRANSFER_PAUSED = 0xcd1fda9f;

    /// @notice The underlying's revert for a transfer from or to a denylisted account. Measured.
    bytes4 internal constant DENYLISTED = 0x1ba1f3e6;

    bytes32 internal constant EVENT = keccak256("an event");

    address internal resolver = makeAddr("resolver");
    address internal holder = makeAddr("holder");

    IERC20 internal underlying;
    IERC20 internal dollar;
    MarketFactory internal factory;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;
    uint256 internal underlyingAmount = 1e17;
    uint256 internal dollarAmount = 100e6;

    /// @notice Opens on a fork at the pinned block, and has the holder split into both vaults of a
    ///         market with as much again left over to try another split.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);

        underlying = IERC20(AddressBook.thirdParty("collateral", 0));
        dollar = IERC20(AddressBook.thirdParty("dollar", 0));
        assertEq(block.chainid, PRODUCTION_CHAIN, "not on a fork of the production chain");
        assertEq(block.number, pinned, "not at the pinned block");

        factory = new MarketFactory();
        (underlyingVault, dollarVault) = factory.markets(
            factory.createMarket(
                underlying, dollar, EVENT, resolver, type(uint256).max, type(uint256).max
            )
        );
        _fund(underlyingVault, underlyingAmount);
        _fund(dollarVault, dollarAmount);
    }

    /// @notice The underlying's per-token pause freezes its vault, and only its vault.
    function testFork_aTokenPauseFreezesTheUnderlyingVaultUntilLifted() public {
        IStockFactory stocks = IStockFactory(IGovernedStock(address(underlying)).FACTORY());
        address pauser = stocks.getRoleMember(stocks.TOKEN_PAUSE_ROLE(), 0);

        _setTransfersPaused(stocks, pauser, true);
        _assertStillMerges(dollarVault, dollarAmount);
        _assertFrozen(underlyingVault, underlyingAmount, abi.encodeWithSelector(TRANSFER_PAUSED));

        _setTransfersPaused(stocks, pauser, false);
        _assertReleased(underlyingVault, underlyingAmount);
    }

    /// @notice A denylisted vault is frozen, and the key that adds to the denylist cannot lift it.
    function testFork_aDenylistedUnderlyingVaultIsFrozenUntilRemoved() public {
        IDenylist denylist = IDenylist(IGovernedStock(address(underlying)).COMPLIANCE());
        address adder = denylist.getRoleMember(_role(denylist, DENYLIST_ADDER_ROLE), 0);
        bytes32 removerRole = _role(denylist, DENYLIST_REMOVER_ROLE);
        address remover = denylist.getRoleMember(removerRole, 0);
        address[] memory accounts = new address[](1);
        accounts[0] = address(underlyingVault);

        vm.prank(adder);
        denylist.addToDenylist(accounts);
        _assertFrozen(underlyingVault, underlyingAmount, abi.encodeWithSelector(DENYLISTED));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, adder, removerRole
            )
        );
        vm.prank(adder);
        denylist.removeFromDenylist(accounts);

        vm.prank(remover);
        denylist.removeFromDenylist(accounts);
        _assertReleased(underlyingVault, underlyingAmount);
    }

    /// @notice The dollar's pause freezes its vault, and only its vault.
    function testFork_aDollarPauseFreezesTheDollarVaultUntilLifted() public {
        IFiatToken fiat = IFiatToken(address(dollar));

        vm.prank(fiat.pauser());
        fiat.pause();
        _assertStillMerges(underlyingVault, underlyingAmount);
        _assertFrozen(dollarVault, dollarAmount, bytes("Pausable: paused"));

        vm.prank(fiat.pauser());
        fiat.unpause();
        _assertReleased(dollarVault, dollarAmount);
    }

    /// @notice A blacklisted dollar vault is frozen until the blacklister lifts it.
    function testFork_aBlacklistedDollarVaultIsFrozenUntilRemoved() public {
        IFiatToken fiat = IFiatToken(address(dollar));

        vm.prank(fiat.blacklister());
        fiat.blacklist(address(dollarVault));
        _assertFrozen(dollarVault, dollarAmount, bytes("Blacklistable: account is blacklisted"));

        vm.prank(fiat.blacklister());
        fiat.unBlacklist(address(dollarVault));
        _assertReleased(dollarVault, dollarAmount);
    }

    /// @notice Gives the holder twice the amount, and splits once.
    /// @dev The balance is fabricated with the storage cheatcode; nothing here reads the supply.
    /// @param vault The vault.
    /// @param amount How much to split.
    function _fund(PositionVault vault, uint256 amount) private {
        IERC20 collateral = vault.COLLATERAL();
        deal(address(collateral), holder, 2 * amount);
        vm.startPrank(holder);
        collateral.approve(address(vault), 2 * amount);
        vault.splitPosition(amount);
        vm.stopPrank();
    }

    /// @notice Pauses or resumes the underlying's transfers, as the holder of the pause role.
    /// @param stocks The underlying's factory.
    /// @param pauser The holder of the role.
    /// @param paused Whether to pause.
    function _setTransfersPaused(IStockFactory stocks, address pauser, bool paused) private {
        vm.prank(pauser);
        (bool success,) = address(stocks)
            .call(abi.encodeWithSelector(SET_TRANSFERS_PAUSED, address(underlying), paused));
        assertTrue(success, "the holder of the pause role could not pause");
    }

    /// @notice Reads a role from one of the compliance module's unnamed getters.
    /// @param denylist The module.
    /// @param getter The getter's selector.
    /// @return role The role.
    function _role(IDenylist denylist, bytes4 getter) private view returns (bytes32 role) {
        (bool success, bytes memory data) =
            address(denylist).staticcall(abi.encodeWithSelector(getter));
        assertTrue(success, "the role getter is gone");
        role = abi.decode(data, (bytes32));
    }

    /// @notice A vault untouched by the power still merges.
    /// @param vault The vault.
    /// @param amount How much the holder split into it.
    function _assertStillMerges(PositionVault vault, uint256 amount) private {
        uint256 before = vault.COLLATERAL().balanceOf(holder);
        vm.prank(holder);
        vault.mergePositions(amount / 2);
        assertEq(vault.COLLATERAL().balanceOf(holder), before + amount / 2);
    }

    /// @notice Splitting, merging and, once the outcome is reported, redeeming all revert with the
    ///         issuer's reason.
    /// @param vault The frozen vault.
    /// @param amount How much the holder split into it.
    /// @param reason The issuer's revert.
    function _assertFrozen(PositionVault vault, uint256 amount, bytes memory reason) private {
        vm.startPrank(holder);
        vm.expectRevert(reason);
        vault.splitPosition(amount);
        vm.expectRevert(reason);
        vault.mergePositions(amount);
        vm.stopPrank();

        vm.prank(resolver);
        factory.reportOutcome(EVENT, Outcome.Yes);

        vm.expectRevert(reason);
        vm.prank(holder);
        vault.redeemPositions(amount, amount);
    }

    /// @notice Once the power is lifted, half the legs merge and the rest redeem under the reported
    ///         yes, and the holder has back every unit it split.
    /// @param vault The released vault.
    /// @param amount How much the holder split into it.
    function _assertReleased(PositionVault vault, uint256 amount) private {
        IERC20 collateral = vault.COLLATERAL();
        uint256 before = collateral.balanceOf(holder);
        uint256 half = amount / 2;
        vm.startPrank(holder);
        vault.mergePositions(half);
        vault.redeemPositions(amount - half, amount - half);
        vm.stopPrank();
        assertEq(collateral.balanceOf(holder), before + amount, "a unit was lost to the freeze");
        assertEq(collateral.balanceOf(address(vault)), 0);
    }
}
