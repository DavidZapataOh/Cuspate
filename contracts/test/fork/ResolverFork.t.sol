// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";

/// @notice The dollar's pause, as far as this suite uses it.
interface IPausableDollar {
    /// @notice Who may pause.
    /// @return The pauser.
    function pauser() external view returns (address);

    /// @notice Stops every transfer.
    function pause() external;

    /// @notice Resumes transfers.
    function unpause() external;
}

/// @title ResolverForkTest
/// @notice A market over both real collaterals, resolved by a bonded proposal posted in the real
///         dollar, as the tokens are on the production chain at a pinned block. This contract is the
///         arbiter.
contract ResolverForkTest is Test {
    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    uint256 internal constant BOND = 500e6;
    uint256 internal constant LIVENESS = 2 hours;

    address internal sealer = makeAddr("sealer");
    address internal proposer = makeAddr("proposer");
    address internal holder = makeAddr("holder");

    IERC20 internal underlying;
    IERC20 internal dollar;
    OptimisticResolver internal resolver;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;
    bytes32 internal eventId;
    uint64 internal announcesAt;

    /// @notice A sealed event, a market over it with the resolver, and a holder who split into both
    ///         vaults; the proposer holds the bond.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);
        assertEq(block.chainid, PRODUCTION_CHAIN, "not on a fork of the production chain");
        assertEq(block.number, pinned, "not at the pinned block");
        underlying = IERC20(AddressBook.thirdParty("collateral", 0));
        dollar = IERC20(AddressBook.thirdParty("dollar", 0));

        ThresholdRegistry registry = new ThresholdRegistry();
        MarketFactory factory = new MarketFactory();
        resolver = new OptimisticResolver(
            factory, registry, sealer, address(this), dollar, BOND, BOND / 5, LIVENESS
        );
        announcesAt = uint64(block.timestamp + 1 days);
        vm.prank(sealer);
        eventId = registry.seal(
            ThresholdRegistry.Threshold({
                value: 123,
                decimals: 2,
                announcesAt: announcesAt,
                deadline: announcesAt + 8 days,
                terms: "earnings per share, diluted, as first published"
            })
        );
        (underlyingVault, dollarVault) =
            factory.markets(factory.createMarket(underlying, dollar, eventId, address(resolver)));
        _split(underlyingVault, 1e17);
        _split(dollarVault, 100e6);

        deal(address(dollar), proposer, BOND);
        vm.prank(proposer);
        dollar.approve(address(resolver), BOND);
    }

    /// @notice Proposed, left undisputed through the window, settled: both vaults redeem and the
    ///         proposer has its bond back to the unit.
    function testFork_anHonestProposalSettlesInTheRealDollar() public {
        _proposeAndWait();
        resolver.settle(eventId);
        _redeemAll(underlyingVault, 1e17);
        _redeemAll(dollarVault, 100e6);
        vm.prank(proposer);
        resolver.withdraw();
        assertEq(dollar.balanceOf(proposer), BOND, "the bond did not come back in full");
    }

    /// @notice With the dollar paused by its issuer, settlement still reports the outcome and the
    ///         underlying vault redeems; the bond, and the dollar vault, wait for the unpause.
    function testFork_aPausedDollarDelaysOnlyTheBond() public {
        _proposeAndWait();
        IPausableDollar pausable = IPausableDollar(address(dollar));
        vm.prank(pausable.pauser());
        pausable.pause();

        resolver.settle(eventId);
        _redeemAll(underlyingVault, 1e17);
        vm.expectRevert(bytes("Pausable: paused"));
        vm.prank(proposer);
        resolver.withdraw();

        vm.prank(pausable.pauser());
        pausable.unpause();
        vm.prank(proposer);
        resolver.withdraw();
        _redeemAll(dollarVault, 100e6);
        assertEq(dollar.balanceOf(proposer), BOND, "the bond did not come back in full");
    }

    /// @notice Disputed twice and ruled by the arbiter while the dollar is paused: the ruling still
    ///         reports the reversed outcome and the underlying vault redeems; the winner's credit waits
    ///         for the unpause.
    function testFork_aRulingReportsWhileTheDollarIsPaused() public {
        address disputer = makeAddr("disputer");
        address second = makeAddr("second proposer");
        deal(address(dollar), disputer, 2 * BOND);
        deal(address(dollar), second, BOND);
        vm.prank(disputer);
        dollar.approve(address(resolver), 2 * BOND);
        vm.prank(second);
        dollar.approve(address(resolver), BOND);

        vm.warp(announcesAt);
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
        vm.prank(disputer);
        resolver.dispute(eventId);
        vm.prank(second);
        resolver.proposeFigure(eventId, 120, 2);
        vm.prank(disputer);
        resolver.dispute(eventId);

        IPausableDollar pausable = IPausableDollar(address(dollar));
        vm.prank(pausable.pauser());
        pausable.pause();
        resolver.ruleFigure(eventId, 125, 2, false, "the primary source published 1.25");
        _redeemAll(underlyingVault, 1e17);

        vm.prank(pausable.pauser());
        pausable.unpause();
        vm.prank(disputer);
        resolver.withdraw();
        assertEq(
            dollar.balanceOf(disputer),
            2 * BOND - resolver.BURN(),
            "the winner was not credited the loser's bond"
        );
    }

    /// @notice Proposes a figure above the threshold at the announcement and waits out the window.
    function _proposeAndWait() internal {
        vm.warp(announcesAt);
        vm.prank(proposer);
        resolver.proposeFigure(eventId, 125, 2);
        vm.warp(block.timestamp + LIVENESS);
    }

    /// @notice Gives the holder collateral and splits it.
    /// @dev The balance is fabricated with the storage cheatcode; nothing here reads the supply.
    /// @param vault The vault.
    /// @param amount How much.
    function _split(PositionVault vault, uint256 amount) internal {
        IERC20 collateral = vault.COLLATERAL();
        deal(address(collateral), holder, amount);
        vm.startPrank(holder);
        collateral.approve(address(vault), amount);
        vault.splitPosition(amount);
        vm.stopPrank();
    }

    /// @notice Redeems both legs under the settled yes and checks the holder got everything back.
    /// @param vault The vault.
    /// @param amount How much the holder split.
    function _redeemAll(PositionVault vault, uint256 amount) internal {
        IERC20 collateral = vault.COLLATERAL();
        vm.prank(holder);
        vault.redeemPositions(amount, amount);
        assertEq(collateral.balanceOf(holder), amount, "a holder was not paid in full");
    }
}
