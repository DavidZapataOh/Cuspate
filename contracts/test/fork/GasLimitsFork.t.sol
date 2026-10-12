// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {GasCases} from "../unit/GasBudgets.t.sol";

/// @title GasLimitsForkTest
/// @notice The cases over the real underlying and dollar at the pinned block: what users pay, and
///         so the limits an interface sets, since gas is charged on the limit.
contract GasLimitsForkTest is GasCases {
    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    /// @notice Opens on a fork at the pinned block before creating the market.
    function setUp() public override {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);
        assertEq(block.chainid, PRODUCTION_CHAIN, "not on a fork of the production chain");
        assertEq(block.number, pinned, "not at the pinned block");
        super.setUp();
    }

    /// @notice The file the values are recorded in.
    /// @return The group: limits.
    function _group() internal pure override returns (string memory) {
        return "limits";
    }

    /// @notice The two collaterals the market is created over.
    /// @return The underlying.
    /// @return The dollar.
    function _collaterals() internal view override returns (IERC20, IERC20) {
        return (
            IERC20(AddressBook.thirdParty("collateral", 0)),
            IERC20(AddressBook.thirdParty("dollar", 0))
        );
    }
}
