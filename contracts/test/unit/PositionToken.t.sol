// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {PositionToken} from "../../src/PositionToken.sol";

/// @title PositionTokenTest
/// @notice A pair of legs: the two outcomes of one collateral, minted and burned only by their
///         minter.
contract PositionTokenTest is Test {
    address internal minter = makeAddr("minter");
    address internal holder = makeAddr("holder");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AMOUNT = 5e18;

    PositionToken[2] internal legs;

    /// @notice A pair of legs over an eighteen-decimal collateral, under a test minter.
    function setUp() public {
        legs = _pair(18);
    }

    /// @notice Both legs credited by exactly the amount minted.
    function test_mintCreditsBothLegsExactly() public {
        _mintPair(holder, AMOUNT);
        for (uint256 leg = 0; leg < 2; leg++) {
            assertEq(legs[leg].balanceOf(holder), AMOUNT);
            assertEq(legs[leg].totalSupply(), AMOUNT);
        }
    }

    /// @notice Both legs debited by exactly the amount burned.
    function test_burnDebitsBothLegsExactly() public {
        _mintPair(holder, AMOUNT);
        vm.startPrank(minter);
        legs[0].burn(holder, AMOUNT / 5);
        legs[1].burn(holder, AMOUNT / 5);
        vm.stopPrank();
        for (uint256 leg = 0; leg < 2; leg++) {
            assertEq(legs[leg].balanceOf(holder), AMOUNT - AMOUNT / 5);
            assertEq(legs[leg].totalSupply(), AMOUNT - AMOUNT / 5);
        }
    }

    /// @notice A transfer moves only the leg transferred.
    function test_transferMovesOnlyThatLeg() public {
        _mintPair(holder, AMOUNT);
        vm.prank(holder);
        assertTrue(legs[0].transfer(recipient, AMOUNT / 2));
        assertEq(legs[0].balanceOf(holder), AMOUNT / 2);
        assertEq(legs[0].balanceOf(recipient), AMOUNT / 2);
        assertEq(legs[1].balanceOf(holder), AMOUNT);
        assertEq(legs[1].balanceOf(recipient), 0);
    }

    /// @notice Anyone but the minter is refused a mint, by a typed error naming them.
    function test_RevertWhen_mintCallerIsNotTheMinter() public {
        vm.expectRevert(abi.encodeWithSelector(PositionToken.NotMinter.selector, stranger));
        vm.prank(stranger);
        legs[0].mint(stranger, AMOUNT);
    }

    /// @notice Anyone but the minter is refused a burn, by a typed error naming them.
    function test_RevertWhen_burnCallerIsNotTheMinter() public {
        _mintPair(holder, AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(PositionToken.NotMinter.selector, stranger));
        vm.prank(stranger);
        legs[0].burn(holder, AMOUNT);
    }

    /// @notice A burn larger than the holder's balance is refused, naming the shortfall.
    function test_RevertWhen_burnExceedsBalance() public {
        _mintPair(holder, AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, holder, AMOUNT, AMOUNT + 1
            )
        );
        vm.prank(minter);
        legs[0].burn(holder, AMOUNT + 1);
    }

    /// @notice A leg reports its collateral's decimals, whatever they are.
    function test_decimalsAreTheCollateralDecimals() public {
        PositionToken[2] memory dollarLegs = _pair(6);
        for (uint256 leg = 0; leg < 2; leg++) {
            assertEq(dollarLegs[leg].decimals(), 6);
            assertEq(legs[leg].decimals(), 18);
        }
    }

    /// @notice A leg constructed with no minter is refused, since nobody could ever mint it.
    function test_RevertWhen_minterIsZero() public {
        vm.expectRevert(PositionToken.ZeroMinter.selector);
        new PositionToken("leg", "LEG", 18, address(0));
    }

    /// @notice Deploys a pair of legs under the test minter.
    /// @param collateralDecimals The collateral's decimals.
    /// @return pair The two legs.
    function _pair(uint8 collateralDecimals) private returns (PositionToken[2] memory pair) {
        pair[0] = new PositionToken("outcome true", "LEG1", collateralDecimals, minter);
        pair[1] = new PositionToken("outcome false", "LEG0", collateralDecimals, minter);
    }

    /// @notice Mints both legs to a holder, as the minter.
    /// @param to The holder.
    /// @param amount How much of each.
    function _mintPair(address to, uint256 amount) private {
        vm.startPrank(minter);
        legs[0].mint(to, amount);
        legs[1].mint(to, amount);
        vm.stopPrank();
    }
}
