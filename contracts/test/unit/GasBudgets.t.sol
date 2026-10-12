// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
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
    ThresholdRegistry internal registry;
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
        registry = new ThresholdRegistry();
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

    /// @notice Sealing a threshold, with one-slot terms and with terms of the length a real market
    ///         needs.
    function test_seal() public {
        uint256[2] memory lengths = [uint256(31), 500];
        string[2] memory cases = [
            "ThresholdRegistry.seal terms of 31 bytes", "ThresholdRegistry.seal terms of 500 bytes"
        ];
        for (uint256 i = 0; i < 2; i++) {
            // Written out, not zeroed: storing a zero byte is nearly free, so empty terms would
            // understate what any real terms cost.
            bytes memory terms = new bytes(lengths[i]);
            for (uint256 j = 0; j < terms.length; j++) {
                terms[j] = "a";
            }
            ThresholdRegistry.Threshold memory threshold = ThresholdRegistry.Threshold({
                value: 123,
                decimals: 2,
                announcesAt: uint64(vm.getBlockTimestamp() + 1 days),
                deadline: uint64(vm.getBlockTimestamp() + 9 days),
                terms: terms
            });
            registry.seal(threshold);
            _record(cases[i], "");
        }
    }

    /// @notice A resolver's life for two events: a figure proposed, settled and its bond withdrawn, and
    ///         an event proposed invalid after its deadline. Each in its worst case: the resolver's first
    ///         bond, the proposer's first credit, a withdrawal to a proposer left with nothing.
    function test_resolver() public {
        IERC20 bondToken = dollarVault.COLLATERAL();
        uint256 bond = 10 ** IERC20Metadata(address(bondToken)).decimals();
        OptimisticResolver resolver_ = new OptimisticResolver(
            factory,
            registry,
            address(this),
            address(this),
            bondToken,
            bond,
            bond / 5,
            2 hours,
            7 days,
            7 days
        );
        address proposer = makeAddr("bonded proposer");
        deal(address(bondToken), proposer, 2 * bond);
        vm.prank(proposer);
        bondToken.approve(address(resolver_), 2 * bond);

        uint64 announcesAt = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 figureEvent = registry.seal(_sealable(announcesAt, "a figure"));
        bytes32 invalidEvent = registry.seal(_sealable(announcesAt, "no figure"));

        vm.warp(announcesAt);
        assertEq(bondToken.balanceOf(address(resolver_)), 0);
        vm.prank(proposer);
        resolver_.proposeFigure(figureEvent, 125, 2);
        _record("OptimisticResolver.proposeFigure the resolver's first bond", "");

        vm.warp(vm.getBlockTimestamp() + 2 hours);
        assertEq(resolver_.owed(proposer), 0);
        resolver_.settle(figureEvent);
        _record("OptimisticResolver.settle a figure, the proposer's first credit", "");

        vm.warp(uint256(announcesAt) + 8 days + 1);
        vm.prank(proposer);
        resolver_.proposeInvalid(invalidEvent);
        _record("OptimisticResolver.proposeInvalid after the deadline", "");

        vm.warp(vm.getBlockTimestamp() + 2 hours);
        resolver_.settle(invalidEvent);
        assertEq(bondToken.balanceOf(proposer), 0);
        vm.prank(proposer);
        resolver_.withdraw();
        _record("OptimisticResolver.withdraw two bonds, to a proposer with nothing", "");
    }

    /// @notice A ruling's reason at its maximum length, so the measured rulings are the costliest.
    /// @param resolver_ The resolver whose maximum it is.
    /// @return The reason.
    function _longestReason(OptimisticResolver resolver_) internal view returns (string memory) {
        bytes memory reason = new bytes(resolver_.MAX_REASON());
        for (uint256 i = 0; i < reason.length; i++) {
            reason[i] = "r";
        }
        return string(reason);
    }

    /// @notice Disputes and rulings, each in its worst case: a first dispute that resets an event, a
    ///         second that sends it to the arbiter, and the arbiter's three rulings, each with a reason
    ///         of the longest length allowed.
    function test_disputes() public {
        IERC20 bondToken = dollarVault.COLLATERAL();
        uint256 bond = 10 ** IERC20Metadata(address(bondToken)).decimals();
        OptimisticResolver resolver_ = new OptimisticResolver(
            factory,
            registry,
            address(this),
            address(this),
            bondToken,
            bond,
            bond / 5,
            2 hours,
            7 days,
            7 days
        );
        address[3] memory parties =
            [makeAddr("first proposer"), makeAddr("disputer"), makeAddr("second proposer")];
        for (uint256 i = 0; i < 3; i++) {
            deal(address(bondToken), parties[i], 10 * bond);
            vm.prank(parties[i]);
            bondToken.approve(address(resolver_), 10 * bond);
        }
        uint64 announcesAt = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 ruledByFigure = registry.seal(_sealable(announcesAt, "ruled by figure"));
        bytes32 ruledInvalid = registry.seal(_sealable(announcesAt, "ruled invalid"));
        vm.warp(announcesAt);

        _escalate(resolver_, ruledByFigure, parties, true);
        resolver_.ruleContest(ruledByFigure, true, _longestReason(resolver_));
        _record("OptimisticResolver.ruleContest the first contest of an event", "");
        resolver_.ruleFigure(ruledByFigure, 125, 2, false, _longestReason(resolver_));
        _record("OptimisticResolver.ruleFigure a disputed second proposal", "");

        _escalate(resolver_, ruledInvalid, parties, false);
        vm.warp(uint256(announcesAt) + 8 days + 1);
        resolver_.ruleInvalid(ruledInvalid, false, _longestReason(resolver_));
        _record("OptimisticResolver.ruleInvalid a disputed second proposal, after the deadline", "");
    }

    /// @notice The exits anyone may take: expiring an event nobody resolved, expiring one the arbiter
    ///         left, and releasing a first contest the arbiter never ruled.
    function test_timeouts() public {
        IERC20 bondToken = dollarVault.COLLATERAL();
        uint256 bond = 10 ** IERC20Metadata(address(bondToken)).decimals();
        OptimisticResolver resolver_ = new OptimisticResolver(
            factory,
            registry,
            address(this),
            address(this),
            bondToken,
            bond,
            bond / 5,
            2 hours,
            7 days,
            7 days
        );
        address[3] memory parties =
            [makeAddr("first proposer"), makeAddr("disputer"), makeAddr("second proposer")];
        for (uint256 i = 0; i < 3; i++) {
            deal(address(bondToken), parties[i], 10 * bond);
            vm.prank(parties[i]);
            bondToken.approve(address(resolver_), 10 * bond);
        }
        uint64 announcesAt = uint64(vm.getBlockTimestamp() + 1 days);
        bytes32 unresolved = registry.seal(_sealable(announcesAt, "nobody resolves it"));
        bytes32 silent = registry.seal(_sealable(announcesAt, "the arbiter is silent"));
        vm.warp(announcesAt);
        _escalate(resolver_, silent, parties, false);

        vm.warp(resolver_.expiresAt(unresolved) + 1);
        resolver_.expire(unresolved);
        _record("OptimisticResolver.expire an event nobody resolved", "");

        vm.warp(resolver_.outcomeTimeout(silent));
        resolver_.expire(silent);
        _record("OptimisticResolver.expire an event the arbiter left, returning both bonds", "");

        resolver_.release(silent);
        _record("OptimisticResolver.release a first contest the arbiter never ruled", "");
    }

    /// @notice Proposes, disputes, proposes again and disputes again, recording both disputes once.
    /// @param resolver_ The resolver.
    /// @param id The event.
    /// @param parties The first proposer, the disputer and the second proposer.
    /// @param recordDisputes Whether to record the two disputes.
    function _escalate(
        OptimisticResolver resolver_,
        bytes32 id,
        address[3] memory parties,
        bool recordDisputes
    ) internal {
        vm.prank(parties[0]);
        resolver_.proposeFigure(id, 125, 2);
        vm.prank(parties[1]);
        resolver_.dispute(id);
        if (recordDisputes) {
            _record("OptimisticResolver.dispute a first proposal, resetting the event", "");
        }
        vm.prank(parties[2]);
        resolver_.proposeFigure(id, 120, 2);
        vm.prank(parties[1]);
        resolver_.dispute(id);
        if (recordDisputes) {
            _record("OptimisticResolver.dispute a second proposal, to the arbiter", "");
        }
    }

    /// @notice A threshold of 1.23, due at a given instant, with a deadline eight days later.
    /// @param announcesAt When the figure may be public.
    /// @param terms Its terms.
    /// @return The threshold.
    function _sealable(uint64 announcesAt, bytes memory terms)
        internal
        pure
        returns (ThresholdRegistry.Threshold memory)
    {
        return ThresholdRegistry.Threshold({
            value: 123,
            decimals: 2,
            announcesAt: announcesAt,
            deadline: announcesAt + 8 days,
            terms: terms
        });
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
