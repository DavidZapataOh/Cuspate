// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PositionToken} from "../../src/PositionToken.sol";

/// @title PositionTokenFuzzTest
/// @notice Supply conservation for a leg over any amount.
contract PositionTokenFuzzTest is Test {
    address internal minter = makeAddr("minter");
    address internal holder = makeAddr("holder");

    PositionToken internal leg;

    /// @notice A leg under a test minter.
    function setUp() public {
        leg = new PositionToken("outcome true", "LEG1", 18, minter);
    }

    /// @notice Minting then burning the same amount leaves supply and balance where they began.
    /// @param amount Any amount.
    function testFuzz_mintThenBurnRestoresSupply(uint256 amount) public {
        vm.startPrank(minter);
        leg.mint(holder, amount);
        assertEq(leg.totalSupply(), amount);
        leg.burn(holder, amount);
        vm.stopPrank();
        assertEq(leg.totalSupply(), 0);
        assertEq(leg.balanceOf(holder), 0);
    }
}
