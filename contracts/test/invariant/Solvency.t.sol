// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";
import {TestCollateral} from "../unit/PositionVault.t.sol";
import {TestStock} from "../unit/MarketFactory.t.sol";

/// @title SolvencyHandler
/// @notice Splits, merges, moves legs between actors, reports the outcome once at a random moment,
///         and redeems after it, with every amount bounded to what is valid so the campaign never
///         reverts. Records everything that went in and came out.
/// @dev Declared in the campaign's test file: a handler is test infrastructure, and a file of its
///      own would make it a first-party contract the protocol's gates have to account for.
contract SolvencyHandler is CommonBase, StdCheats, StdUtils {
    bytes32 internal constant EVENT = keccak256("an event");

    /// @notice The factory the market was created by, which is where its outcome is reported.
    MarketFactory public immutable FACTORY;

    /// @notice The vault under test.
    PositionVault public immutable VAULT;

    /// @notice Who reports the outcome.
    address public immutable RESOLVER;

    /// @notice Everything ever split, merged and redeemed.
    uint256 public split;
    /// @notice Everything ever merged.
    uint256 public merged;
    /// @notice Everything ever paid out by redemption.
    uint256 public redeemed;
    /// @notice Everything ever sent to the vault outside a split.
    uint256 public donated;
    /// @notice How many redemptions there have been.
    uint256 public redemptions;

    /// @notice How many calls changed state.
    uint256 public stateChangingCalls;

    address[3] internal actors = [address(0x1000), address(0x2000), address(0x3000)];

    /// @notice Takes the market to drive.
    /// @param factory The factory.
    /// @param vault The vault.
    /// @param resolver Who reports.
    constructor(MarketFactory factory, PositionVault vault, address resolver) {
        FACTORY = factory;
        VAULT = vault;
        RESOLVER = resolver;
    }

    /// @notice Whether the outcome has been reported.
    /// @return True once it has.
    function resolved() public view returns (bool) {
        return FACTORY.outcomeOf(VAULT.CONDITION()) != Outcome.Unresolved;
    }

    /// @notice Splits for an actor before resolution, or redeems for it after.
    /// @param actorSeed Chooses the actor.
    /// @param amount Bounded to something a vault accepts.
    function splitPosition(uint256 actorSeed, uint256 amount) public {
        address actor = actors[_bound(actorSeed, 0, 2)];
        if (resolved()) {
            redeemPositions(actorSeed);
            return;
        }
        amount = _bound(amount, 1, 1e30);
        IERC20 collateral = VAULT.COLLATERAL();
        TestCollateral(address(collateral)).mint(actor, amount);
        vm.startPrank(actor);
        collateral.approve(address(VAULT), amount);
        VAULT.splitPosition(amount);
        vm.stopPrank();
        split += amount;
        stateChangingCalls++;
    }

    /// @notice Merges some of what an actor holds of both legs, or splits if it holds none.
    /// @param actorSeed Chooses the actor.
    /// @param amount Bounded to what the actor holds of both.
    function mergePositions(uint256 actorSeed, uint256 amount) external {
        address actor = actors[_bound(actorSeed, 0, 2)];
        uint256 yes = VAULT.YES().balanceOf(actor);
        uint256 no = VAULT.NO().balanceOf(actor);
        uint256 held = yes < no ? yes : no;
        if (held == 0) {
            splitPosition(actorSeed, amount);
            return;
        }
        amount = _bound(amount, 1, held);
        IERC20 collateral = VAULT.COLLATERAL();
        uint256 before = collateral.balanceOf(actor);
        vm.prank(actor);
        VAULT.mergePositions(amount);
        merged += collateral.balanceOf(actor) - before;
        stateChangingCalls++;
    }

    /// @notice Moves part of one actor's balance of one leg to another, at any time.
    /// @param fromSeed Chooses the sender.
    /// @param toSeed Chooses the recipient.
    /// @param yesLeg Whether the yes leg moves, or the no leg.
    /// @param amount Bounded to the sender's balance.
    function transferLeg(uint256 fromSeed, uint256 toSeed, bool yesLeg, uint256 amount) external {
        address from = actors[_bound(fromSeed, 0, 2)];
        address to = actors[_bound(toSeed, 0, 2)];
        IERC20 leg = yesLeg ? VAULT.YES() : VAULT.NO();
        uint256 held = leg.balanceOf(from);
        if (held == 0) {
            splitPosition(fromSeed, amount);
            return;
        }
        vm.prank(from);
        leg.transfer(to, _bound(amount, 1, held));
        stateChangingCalls++;
    }

    /// @notice Sends collateral to the vault outside a split, as anyone can on chain.
    /// @param amount Bounded to something small, so it never dominates.
    function donate(uint256 amount) external {
        amount = _bound(amount, 1, 1e6);
        TestCollateral(address(VAULT.COLLATERAL())).mint(address(VAULT), amount);
        donated += amount;
        stateChangingCalls++;
    }

    /// @notice Reports a final outcome once, after something has been split; before that it splits,
    ///         and after the report it redeems. Reporting over an empty vault would leave the rest of
    ///         the run with nothing to redeem, a campaign that tests nothing and still passes.
    /// @param outcomeSeed Chooses the outcome.
    function reportOutcome(uint8 outcomeSeed) external {
        if (resolved()) {
            redeemPositions(outcomeSeed);
            return;
        }
        if (split == 0) {
            splitPosition(outcomeSeed, outcomeSeed);
            return;
        }
        vm.prank(RESOLVER);
        FACTORY.reportOutcome(EVENT, Outcome(_bound(outcomeSeed, 1, 3)));
        stateChangingCalls++;
    }

    /// @notice Redeems everything an actor holds after resolution, or splits for it before.
    /// @param actorSeed Chooses the actor.
    function redeemPositions(uint256 actorSeed) public {
        address actor = actors[_bound(actorSeed, 0, 2)];
        if (!resolved()) {
            splitPosition(actorSeed, actorSeed);
            return;
        }
        IERC20 collateral = VAULT.COLLATERAL();
        uint256 before = collateral.balanceOf(actor);
        uint256 yes = VAULT.YES().balanceOf(actor);
        uint256 no = VAULT.NO().balanceOf(actor);
        vm.prank(actor);
        VAULT.redeemPositions(yes, no);
        redeemed += collateral.balanceOf(actor) - before;
        redemptions++;
        stateChangingCalls++;
    }
}

/// @title SolvencyTest
/// @notice No sequence of splits, merges, transfers, a report and redemptions makes a vault pay out
///         more than was split into it.
contract SolvencyTest is Test {
    SolvencyHandler internal handler;
    PositionVault internal vault;
    MarketFactory internal factory;

    /// @notice One market, with the handler as the campaign's only target.
    function setUp() public {
        factory = new MarketFactory();
        address resolver = makeAddr("resolver");
        bytes32 id = factory.createMarket(
            IERC20(address(new TestStock())),
            IERC20(address(new TestCollateral())),
            keccak256("an event"),
            resolver
        );
        (, vault) = factory.markets(id);
        handler = new SolvencyHandler(factory, vault, resolver);
        targetContract(address(handler));
    }

    /// @notice The vault's collateral covers what its outstanding legs would pay under the reported
    ///         outcome, or under any outcome before one is reported.
    function invariant_collateralCoversEveryClaim() public view {
        uint256 held = vault.COLLATERAL().balanceOf(address(vault));
        uint256 yes = vault.YES().totalSupply();
        uint256 no = vault.NO().totalSupply();
        Outcome outcome = factory.outcomeOf(vault.CONDITION());
        if (outcome == Outcome.Yes) {
            assertGe(held, yes);
        } else if (outcome == Outcome.No) {
            assertGe(held, no);
        } else if (outcome == Outcome.Invalid) {
            assertGe(held, (yes + no) / 2);
        } else {
            assertGe(held, yes > no ? yes : no);
        }
    }

    /// @notice Everything that entered the vault is accounted for: what was merged and redeemed left
    ///         it, and the rest is still there, rounding remainders and donations included.
    function invariant_collateralIsConserved() public view {
        assertEq(
            vault.COLLATERAL().balanceOf(address(vault)) + handler.merged() + handler.redeemed(),
            handler.split() + handler.donated()
        );
    }

    /// @notice Leaving aside what was donated, the vault holds exactly what its legs can claim before
    ///         resolution, and after it at least that, with at most half a unit left over for each
    ///         redemption. Donations hide an overpayment from the property above; this one does not.
    function invariant_roundingLeavesAtMostHalfAUnitPerRedemption() public view {
        uint256 doubledHeld = 2 * (vault.COLLATERAL().balanceOf(address(vault)) - handler.donated());
        uint256 yes = vault.YES().totalSupply();
        uint256 no = vault.NO().totalSupply();
        Outcome outcome = factory.outcomeOf(vault.CONDITION());
        if (outcome == Outcome.Unresolved) {
            assertEq(doubledHeld, 2 * yes);
            assertEq(yes, no);
            return;
        }
        uint256 doubledClaim =
            outcome == Outcome.Yes ? 2 * yes : outcome == Outcome.No ? 2 * no : yes + no;
        assertGe(doubledHeld, doubledClaim, "the legs can claim more than the vault holds");
        assertLe(
            doubledHeld - doubledClaim,
            handler.redemptions(),
            "more than half a unit left per redemption"
        );
    }

    /// @notice Closes the campaign by proving it did something.
    function afterInvariant() public view {
        assertGt(handler.stateChangingCalls(), 0, "the campaign changed no state");
        assertGt(handler.split(), 0, "nothing was ever split");
    }
}
