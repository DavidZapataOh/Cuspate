// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {PositionToken} from "../../src/PositionToken.sol";
import {IOutcomes, Outcome, PositionVault} from "../../src/PositionVault.sol";

/// @title TestCollateral
/// @notice A well-behaved six-decimal collateral that anyone can mint, for tests only.
contract TestCollateral is ERC20 {
    /// @notice Creates the collateral.
    constructor() ERC20("test dollar", "TUSD") {}

    /// @notice Six decimals, like the dollar a market splits.
    /// @return The number of decimals.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Creates collateral for anyone.
    /// @param to The holder credited.
    /// @param amount How much.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title TestOutcomes
/// @notice An outcome source a test can set directly, standing in for a resolver. For tests only.
contract TestOutcomes {
    mapping(bytes32 condition => Outcome outcome) internal reported;

    /// @notice Sets the outcome of a condition.
    /// @param condition The condition.
    /// @param outcome The outcome.
    function set(bytes32 condition, Outcome outcome) external {
        reported[condition] = outcome;
    }

    /// @notice The outcome of a condition.
    /// @param condition The condition.
    /// @return The outcome.
    function outcomeOf(bytes32 condition) external view returns (Outcome) {
        return reported[condition];
    }
}

/// @title ShortDeliveringCollateral
/// @notice Delivers one unit less than it is asked to send, as a token that charges on transfer
///         does. For tests only.
contract ShortDeliveringCollateral is TestCollateral {
    /// @notice Burns one unit of every transfer in flight.
    /// @param from The sender.
    /// @param to The recipient.
    /// @param value How much was asked.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0), 1);
            value -= 1;
        }
        super._update(from, to, value);
    }
}

/// @title OverchargingCollateral
/// @notice Takes one unit more from its sender than it sends. For tests only.
contract OverchargingCollateral is TestCollateral {
    /// @notice Burns one more unit from the sender of every transfer.
    /// @param from The sender.
    /// @param to The recipient.
    /// @param value How much was asked.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0), 1);
        }
        super._update(from, to, value);
    }
}

/// @title ReenteringCollateral
/// @notice Calls back into the vault in the middle of a transfer, as a collateral with transfer
///         hooks could. For tests only.
contract ReenteringCollateral is TestCollateral {
    PositionVault internal target;
    uint256 internal splitAmount;
    uint256 internal mergeAmount;

    /// @notice Arms the callback for the next transfer: a nested split, a nested merge, or both.
    /// @param vault The vault to call back into.
    /// @param nestedSplit How much to split from inside the transfer, or zero for none.
    /// @param nestedMerge How much to merge from inside the transfer, or zero for none.
    function arm(PositionVault vault, uint256 nestedSplit, uint256 nestedMerge) external {
        target = vault;
        splitAmount = nestedSplit;
        mergeAmount = nestedMerge;
    }

    /// @notice Calls back into the vault once, before the transfer it is part of.
    /// @param from The sender.
    /// @param to The recipient.
    /// @param value How much.
    function _update(address from, address to, uint256 value) internal override {
        PositionVault vault = target;
        if (address(vault) != address(0) && from != address(0) && to != address(0)) {
            target = PositionVault(address(0));
            if (splitAmount > 0) vault.splitPosition(splitAmount);
            if (mergeAmount > 0) vault.mergePositions(mergeAmount);
        }
        super._update(from, to, value);
    }
}

/// @title PositionVaultTest
/// @notice Splitting collateral into both legs and merging both legs back, on a collateral that
///         behaves.
contract PositionVaultTest is Test {
    address internal holder = makeAddr("holder");
    address internal buyer = makeAddr("buyer");

    uint256 internal constant AMOUNT = 250e6;

    TestCollateral internal collateral;
    PositionVault internal vault;

    /// @notice A vault over the test collateral, and a holder with collateral approved to it.
    function setUp() public {
        collateral = new TestCollateral();
        vault = new PositionVault(
            IERC20(address(collateral)),
            keccak256("a market"),
            IOutcomes(address(new TestOutcomes())),
            keccak256("a condition"),
            type(uint256).max
        );
        collateral.mint(holder, AMOUNT);
        vm.prank(holder);
        collateral.approve(address(vault), type(uint256).max);
    }

    /// @notice Splitting moves the collateral into the vault and gives the holder one of each leg.
    function test_splitPositionMintsBothLegsAndHoldsTheCollateral() public {
        vm.prank(holder);
        vault.splitPosition(AMOUNT);
        assertEq(collateral.balanceOf(holder), 0);
        assertEq(collateral.balanceOf(address(vault)), AMOUNT);
        assertEq(vault.YES().balanceOf(holder), AMOUNT);
        assertEq(vault.NO().balanceOf(holder), AMOUNT);
    }

    /// @notice Merging takes one of each leg and gives the collateral back.
    function test_mergePositionsBurnsBothLegsAndReturnsTheCollateral() public {
        vm.startPrank(holder);
        vault.splitPosition(AMOUNT);
        vault.mergePositions(AMOUNT);
        vm.stopPrank();
        assertEq(collateral.balanceOf(holder), AMOUNT);
        assertEq(collateral.balanceOf(address(vault)), 0);
        assertEq(vault.YES().totalSupply(), 0);
        assertEq(vault.NO().totalSupply(), 0);
    }

    /// @notice A split is announced with the stakeholder and the amount.
    function test_splitPositionEmitsPositionSplit() public {
        vm.expectEmit(address(vault));
        emit PositionVault.PositionSplit(holder, AMOUNT);
        vm.prank(holder);
        vault.splitPosition(AMOUNT);
    }

    /// @notice A merge is announced with the stakeholder and the amount.
    function test_mergePositionsEmitsPositionsMerge() public {
        vm.startPrank(holder);
        vault.splitPosition(AMOUNT);
        vm.expectEmit(address(vault));
        emit PositionVault.PositionsMerge(holder, AMOUNT);
        vault.mergePositions(AMOUNT);
        vm.stopPrank();
    }

    /// @notice Both legs answer to the vault and to nothing else.
    function test_legsAreMintedOnlyByTheVault() public view {
        assertEq(vault.YES().MINTER(), address(vault));
        assertEq(vault.NO().MINTER(), address(vault));
    }

    /// @notice Both legs carry the collateral's decimals.
    function test_legsCarryTheCollateralDecimals() public view {
        assertEq(vault.YES().decimals(), 6);
        assertEq(vault.NO().decimals(), 6);
    }

    /// @notice A holder who has sold one leg cannot merge, and the leg says why.
    function test_RevertWhen_mergeWithoutTheOtherLeg() public {
        vm.startPrank(holder);
        vault.splitPosition(AMOUNT);
        PositionToken no = vault.NO();
        assertTrue(no.transfer(buyer, AMOUNT));
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, holder, 0, AMOUNT
            )
        );
        vault.mergePositions(AMOUNT);
        vm.stopPrank();
    }

    /// @notice A collateral that delivers less than the amount is refused, rather than leaving
    ///         legs without collateral behind them.
    function test_RevertWhen_splitReceivesLessThanTheAmount() public {
        (PositionVault shortVault, TestCollateral token) =
            _vaultOver(new ShortDeliveringCollateral());
        vm.expectRevert(
            abi.encodeWithSelector(PositionVault.CollateralMismatch.selector, AMOUNT, AMOUNT - 1)
        );
        vm.prank(holder);
        shortVault.splitPosition(AMOUNT);
        assertEq(token.balanceOf(address(shortVault)), 0);
    }

    /// @notice A collateral that takes more from the vault than it sends is refused, rather than
    ///         draining collateral that backs other holders' legs.
    function test_RevertWhen_mergeSendsMoreThanTheAmount() public {
        OverchargingCollateral token = new OverchargingCollateral();
        (PositionVault overVault,) = _vaultOver(token);
        token.mint(address(overVault), AMOUNT);
        vm.startPrank(holder);
        overVault.splitPosition(AMOUNT / 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.CollateralMismatch.selector, AMOUNT / 2, AMOUNT / 2 + 1
            )
        );
        overVault.mergePositions(AMOUNT / 2);
        vm.stopPrank();
    }

    /// @notice Merging takes only the caller's own legs: another holder's legs and the
    ///         collateral behind them are untouched.
    function test_mergeTakesOnlyTheCallersLegs() public {
        collateral.mint(buyer, AMOUNT);
        vm.prank(holder);
        vault.splitPosition(AMOUNT);
        vm.startPrank(buyer);
        collateral.approve(address(vault), AMOUNT);
        vault.splitPosition(AMOUNT);
        vault.mergePositions(AMOUNT);
        vm.stopPrank();
        assertEq(vault.YES().balanceOf(holder), AMOUNT);
        assertEq(vault.NO().balanceOf(holder), AMOUNT);
        assertEq(collateral.balanceOf(address(vault)), AMOUNT);
    }

    /// @notice A split re-entered from inside its own collateral pull is refused: the outer call
    ///         sees the inner call's collateral as well, which is why no reentrancy guard is needed.
    function test_RevertWhen_splitIsReenteredDuringItsPull() public {
        ReenteringCollateral token = new ReenteringCollateral();
        (PositionVault hooked,) = _vaultOver(token);
        token.mint(address(token), AMOUNT);
        vm.prank(address(token));
        token.approve(address(hooked), type(uint256).max);
        token.arm(hooked, AMOUNT / 2, 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.CollateralMismatch.selector, AMOUNT / 4, AMOUNT / 4 + AMOUNT / 2
            )
        );
        vm.prank(holder);
        hooked.splitPosition(AMOUNT / 4);
    }

    /// @notice A merge re-entered from inside a split's pull moves the balance the wrong way, and
    ///         is refused by the typed error rather than by an arithmetic panic.
    function test_RevertWhen_splitPullLowersTheBalance() public {
        ReenteringCollateral token = new ReenteringCollateral();
        (PositionVault hooked,) = _vaultOver(token);
        token.mint(address(token), AMOUNT);
        vm.startPrank(address(token));
        token.approve(address(hooked), type(uint256).max);
        hooked.splitPosition(AMOUNT);
        vm.stopPrank();
        token.arm(hooked, 0, AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(PositionVault.CollateralMismatch.selector, AMOUNT / 4, 0)
        );
        vm.prank(holder);
        hooked.splitPosition(AMOUNT / 4);
    }

    /// @notice A vault over a given collateral, with the holder funded and approved.
    /// @param token The collateral.
    /// @return created The vault.
    /// @return same The collateral, as passed.
    function _vaultOver(TestCollateral token)
        private
        returns (PositionVault created, TestCollateral same)
    {
        created = new PositionVault(
            IERC20(address(token)),
            keccak256("a market"),
            IOutcomes(address(new TestOutcomes())),
            keccak256("a condition"),
            type(uint256).max
        );
        token.mint(holder, AMOUNT);
        vm.prank(holder);
        token.approve(address(created), type(uint256).max);
        same = token;
    }
}
