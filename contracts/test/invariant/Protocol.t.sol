// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";

/// @title CampaignCollateral
/// @notice A collateral of any number of decimals that anyone can mint, for this campaign only.
contract CampaignCollateral is ERC20 {
    uint8 internal immutable DECIMALS;

    /// @notice Creates the collateral.
    /// @param name_ Its name.
    /// @param symbol_ Its symbol.
    /// @param decimals_ Its decimals.
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        DECIMALS = decimals_;
    }

    /// @notice The decimals it was created with.
    /// @return The decimals.
    function decimals() public view override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Creates collateral for anyone.
    /// @param to The holder credited.
    /// @param amount How much.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title ProtocolHandler
/// @notice Drives the protocol as it is used: markets created over several collaterals and shared
///         conditions, splits, merges, legs moving between holders, donations, reports at random
///         moments and redemptions of every kind. Every amount is bounded to what a user could send,
///         so the campaign never reverts; the two calls the protocol must refuse are attempted on
///         purpose and their exact refusal required. Records what each market was created with, and
///         everything that went in and came out, so the properties never take the protocol's word
///         for its own state.
/// @dev Declared in the campaign's test file: a handler is test infrastructure, and a file of its
///      own would make it a first-party contract the protocol's gates have to account for.
contract ProtocolHandler is CommonBase, StdCheats, StdUtils {
    /// @notice The most markets a run creates. Chosen against the campaign's time budget: every
    ///         property reads every vault after every call.
    uint256 public constant MAX_MARKETS = 4;

    /// @notice The factory under test.
    MarketFactory public immutable FACTORY;

    /// @notice What a vault was created as, from the handler's own inputs.
    struct Created {
        IERC20 collateral;
        bytes32 condition;
        bytes32 marketId;
    }

    /// @notice Everything the handler recorded about one vault, read by the properties in one call.
    struct VaultState {
        PositionVault vault;
        Created created;
        IERC20[2] legs;
        uint256 split;
        uint256 merged;
        uint256 redeemed;
        uint256 donated;
        uint256 oddRedemptions;
        uint256[2] supplyAtReport;
        Outcome outcome;
    }

    CampaignCollateral[3] internal collaterals;
    address[2] internal resolvers = [address(0xAAA1), address(0xAAA2)];
    bytes32[2] internal events = [keccak256("first event"), keccak256("second event")];
    address[3] internal actors = [address(0x1000), address(0x2000), address(0x3000)];

    /// @notice Every vault, in the order created.
    PositionVault[] public vaults;
    /// @notice Every market id, in the order created.
    bytes32[] public marketIds;
    /// @notice What each vault was created as.
    mapping(PositionVault vault => Created) internal created;
    /// @notice The id the factory returned for each market the handler asked for.
    mapping(bytes32 intended => bytes32 returned) public returnedId;
    /// @notice The two vaults the registry named when each market was created.
    mapping(bytes32 marketId => PositionVault[2]) internal recorded;

    /// @notice Collateral split into each vault.
    mapping(PositionVault vault => uint256) internal split;
    /// @notice Collateral merged out of each vault.
    mapping(PositionVault vault => uint256) internal merged;
    /// @notice Collateral redeemed out of each vault.
    mapping(PositionVault vault => uint256) internal redeemed;
    /// @notice Collateral sent to each vault outside a split.
    mapping(PositionVault vault => uint256) internal donated;
    /// @notice Redemptions from each vault whose weighted sum was odd, each leaving half a unit.
    mapping(PositionVault vault => uint256) internal oddRedemptions;
    /// @notice Each leg's supply when its condition was reported; zero for a vault born resolved.
    mapping(PositionVault vault => uint256[2]) internal supplyAtReport;
    /// @notice What the handler's own calls imply each actor holds of each leg (0 yes, 1 no).
    mapping(PositionVault vault => mapping(uint256 leg => mapping(address actor => uint256)))
        internal tally;
    /// @notice The outcome the handler sent for each condition.
    mapping(bytes32 condition => Outcome) public sent;
    /// @notice Each vault's two legs, read once at creation.
    mapping(PositionVault vault => IERC20[2]) internal legsOf;

    /// @notice How many calls changed state.
    uint256 public stateChangingCalls;
    /// @notice How many conditions were reported.
    uint256 public reports;

    /// @notice Creates the collaterals and the first market, so every action has a vault from the
    ///         first call.
    /// @param factory The factory.
    constructor(MarketFactory factory) {
        FACTORY = factory;
        collaterals[0] = new CampaignCollateral("campaign stock", "CSTK", 18);
        collaterals[1] = new CampaignCollateral("campaign dollar", "CUSD", 6);
        collaterals[2] = new CampaignCollateral("campaign bond", "CBND", 8);
        createMarket(0, 0);
    }

    /// @notice How many vaults exist.
    /// @return The count.
    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    /// @notice How many markets exist.
    /// @return The count.
    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    /// @notice Everything recorded about a vault.
    /// @param index Which vault, in the order created.
    /// @return state The record.
    function vaultState(uint256 index) external view returns (VaultState memory state) {
        PositionVault vault = vaults[index];
        state.vault = vault;
        state.created = created[vault];
        state.legs = legsOf[vault];
        state.split = split[vault];
        state.merged = merged[vault];
        state.redeemed = redeemed[vault];
        state.donated = donated[vault];
        state.oddRedemptions = oddRedemptions[vault];
        state.supplyAtReport = supplyAtReport[vault];
        state.outcome = sent[state.created.condition];
    }

    /// @notice What the handler's calls imply each actor holds of a vault's legs.
    /// @param index Which vault, in the order created.
    /// @return tallies By leg (0 yes, 1 no), then by actor.
    function talliesOf(uint256 index) external view returns (uint256[3][2] memory tallies) {
        PositionVault vault = vaults[index];
        for (uint256 leg = 0; leg < 2; leg++) {
            for (uint256 actor = 0; actor < 3; actor++) {
                tallies[leg][actor] = tally[vault][leg][actors[actor]];
            }
        }
    }

    /// @notice The vaults the registry named when a market was created.
    /// @param marketId The market.
    /// @return The underlying vault and the dollar vault.
    function recordedVaults(bytes32 marketId) external view returns (PositionVault, PositionVault) {
        return (recorded[marketId][0], recorded[marketId][1]);
    }

    /// @notice A condition by index: resolver by the low bit, event by the next.
    /// @param index Below four.
    /// @return The condition, computed as the protocol states it.
    function conditionAt(uint256 index) public view returns (bytes32) {
        return keccak256(abi.encode(resolvers[index % 2], events[(index / 2) % 2]));
    }

    /// @notice Whether the handler has reported a vault's condition.
    /// @param vault The vault.
    /// @return True once it has.
    function resolved(PositionVault vault) public view returns (bool) {
        return sent[created[vault].condition] != Outcome.Unresolved;
    }

    /// @notice Creates a market over two distinct collaterals and a condition, or splits if that
    ///         market exists or the run has made enough.
    /// @param pairSeed Chooses the ordered pair.
    /// @param conditionSeed Chooses the resolver and the event.
    function createMarket(uint256 pairSeed, uint256 conditionSeed) public {
        uint256 first = pairSeed % 3;
        uint256 second = (first + 1 + (pairSeed / 3) % 2) % 3;
        IERC20 underlying = collaterals[first];
        IERC20 dollar = collaterals[second];
        uint256 index = conditionSeed % 4;
        bytes32 condition = conditionAt(index);
        bytes32 id = keccak256(abi.encode(underlying, dollar, condition));
        if (marketIds.length >= MAX_MARKETS || address(recorded[id][0]) != address(0)) {
            splitPosition(pairSeed, conditionSeed, conditionSeed);
            return;
        }
        returnedId[id] =
            FACTORY.createMarket(underlying, dollar, events[(index / 2) % 2], resolvers[index % 2]);
        (PositionVault underlyingVault, PositionVault dollarVault) = FACTORY.markets(id);
        recorded[id] = [underlyingVault, dollarVault];
        marketIds.push(id);
        _record(underlyingVault, underlying, condition, id);
        _record(dollarVault, dollar, condition, id);
        stateChangingCalls++;
    }

    /// @notice Splits for an actor into an unresolved vault. On a resolved vault it either attempts
    ///         the split anyway and requires the exact refusal, or redeems.
    /// @param vaultSeed Chooses the vault, and whether a late split is attempted.
    /// @param actorSeed Chooses the actor.
    /// @param amount Bounded to something a vault accepts.
    function splitPosition(uint256 vaultSeed, uint256 actorSeed, uint256 amount) public {
        PositionVault vault = _vault(vaultSeed);
        address actor = actors[actorSeed % 3];
        amount = _bound(amount, 1, 1e30);
        if (!resolved(vault)) {
            _split(vault, actor, amount);
        } else if ((vaultSeed >> 128) % 2 == 1) {
            _attemptLateSplit(vault, actor, amount);
        } else {
            redeemPositions(vaultSeed, actorSeed, amount);
        }
    }

    /// @notice Merges up to what an actor holds of both legs, or splits if it holds none.
    /// @param vaultSeed Chooses the vault.
    /// @param actorSeed Chooses the actor.
    /// @param amount Bounded to what the actor holds of both.
    function mergePositions(uint256 vaultSeed, uint256 actorSeed, uint256 amount) external {
        PositionVault vault = _vault(vaultSeed);
        address actor = actors[actorSeed % 3];
        uint256 yes = vault.YES().balanceOf(actor);
        uint256 no = vault.NO().balanceOf(actor);
        uint256 held = yes < no ? yes : no;
        if (held == 0) {
            splitPosition(vaultSeed, actorSeed, amount);
            return;
        }
        amount = _bound(amount, 1, held);
        IERC20 collateral = created[vault].collateral;
        uint256 before = collateral.balanceOf(actor);
        vm.prank(actor);
        vault.mergePositions(amount);
        merged[vault] += collateral.balanceOf(actor) - before;
        tally[vault][0][actor] -= amount;
        tally[vault][1][actor] -= amount;
        stateChangingCalls++;
    }

    /// @notice Moves part of one actor's balance of one leg to another, at any time.
    /// @param vaultSeed Chooses the vault.
    /// @param fromSeed Chooses the sender.
    /// @param toSeed Chooses the recipient.
    /// @param yesLeg Whether the yes leg moves, or the no leg.
    /// @param amount Bounded to the sender's balance.
    function transferLeg(
        uint256 vaultSeed,
        uint256 fromSeed,
        uint256 toSeed,
        bool yesLeg,
        uint256 amount
    ) external {
        PositionVault vault = _vault(vaultSeed);
        address from = actors[fromSeed % 3];
        address to = actors[toSeed % 3];
        IERC20 leg = yesLeg ? vault.YES() : vault.NO();
        uint256 held = leg.balanceOf(from);
        if (held == 0) {
            splitPosition(vaultSeed, fromSeed, amount);
            return;
        }
        amount = _bound(amount, 1, held);
        vm.prank(from);
        leg.transfer(to, amount);
        uint256 index = yesLeg ? 0 : 1;
        tally[vault][index][from] -= amount;
        tally[vault][index][to] += amount;
        stateChangingCalls++;
    }

    /// @notice Sends collateral to a vault outside a split, as anyone can on chain.
    /// @param vaultSeed Chooses the vault.
    /// @param amount Bounded to something small, so it never dominates.
    function donate(uint256 vaultSeed, uint256 amount) external {
        PositionVault vault = _vault(vaultSeed);
        amount = _bound(amount, 1, 1e6);
        CampaignCollateral(address(created[vault].collateral)).mint(address(vault), amount);
        donated[vault] += amount;
        stateChangingCalls++;
    }

    /// @notice About one call in eight: reports a final outcome for a condition with legs
    ///         outstanding, recording what it sent and every vault's supply at that moment; on a
    ///         condition already reported it attempts a second report and requires the exact
    ///         refusal. Otherwise it splits.
    /// @param conditionSeed Chooses the condition.
    /// @param outcomeSeed Chooses the outcome, and whether this call reports at all.
    function reportOutcome(uint256 conditionSeed, uint256 outcomeSeed) external {
        if ((outcomeSeed >> 8) % 8 != 0) {
            splitPosition(conditionSeed, outcomeSeed, outcomeSeed);
            return;
        }
        uint256 index = conditionSeed % 4;
        bytes32 condition = conditionAt(index);
        address resolver = resolvers[index % 2];
        bytes32 eventId = events[(index / 2) % 2];
        Outcome outcome = Outcome(_bound(outcomeSeed, 1, 3));
        if (sent[condition] != Outcome.Unresolved) {
            vm.prank(resolver);
            (bool accepted, bytes memory reason) = address(FACTORY)
                .call(abi.encodeCall(MarketFactory.reportOutcome, (eventId, outcome)));
            if (!accepted) {
                require(
                    keccak256(reason)
                        == keccak256(
                            abi.encodeWithSelector(
                                MarketFactory.OutcomeAlreadyReported.selector, condition
                            )
                        ),
                    "a second report was refused for the wrong reason"
                );
            }
            return;
        }
        bool outstanding;
        for (uint256 i = 0; i < vaults.length; i++) {
            PositionVault vault = vaults[i];
            if (created[vault].condition == condition) {
                uint256 yes = vault.YES().totalSupply();
                uint256 no = vault.NO().totalSupply();
                supplyAtReport[vault] = [yes, no];
                outstanding = outstanding || yes + no > 0;
            }
        }
        if (!outstanding) {
            splitPosition(conditionSeed, outcomeSeed, outcomeSeed);
            return;
        }
        vm.prank(resolver);
        FACTORY.reportOutcome(eventId, outcome);
        sent[condition] = outcome;
        reports++;
        stateChangingCalls++;
    }

    /// @notice After resolution, redeems what an actor holds: both legs, the yes leg alone or the no
    ///         leg alone. With nothing to redeem, or before resolution, it splits instead.
    /// @param vaultSeed Chooses the vault.
    /// @param actorSeed Chooses the actor.
    /// @param mode Chooses which legs.
    function redeemPositions(uint256 vaultSeed, uint256 actorSeed, uint256 mode) public {
        PositionVault vault = _vault(vaultSeed);
        address actor = actors[actorSeed % 3];
        uint256 yes = mode % 3 == 2 ? 0 : vault.YES().balanceOf(actor);
        uint256 no = mode % 3 == 1 ? 0 : vault.NO().balanceOf(actor);
        if (!resolved(vault) || yes + no == 0) {
            _splitIntoAnyUnresolved(vaultSeed, actor, mode);
            return;
        }
        IERC20 collateral = created[vault].collateral;
        uint256 before = collateral.balanceOf(actor);
        vm.prank(actor);
        vault.redeemPositions(yes, no);
        redeemed[vault] += collateral.balanceOf(actor) - before;
        Outcome outcome = sent[created[vault].condition];
        uint256 weighted =
            outcome == Outcome.Yes ? 2 * yes : outcome == Outcome.No ? 2 * no : yes + no;
        if (weighted % 2 == 1) {
            oddRedemptions[vault]++;
        }
        tally[vault][0][actor] -= yes;
        tally[vault][1][actor] -= no;
        stateChangingCalls++;
    }

    /// @notice A vault chosen by a seed.
    /// @param seed The seed.
    /// @return The vault.
    function _vault(uint256 seed) internal view returns (PositionVault) {
        return vaults[seed % vaults.length];
    }

    /// @notice Records what a new vault was created as. A vault whose condition is already reported
    ///         is born resolved, with nothing outstanding at the report.
    /// @param vault The vault.
    /// @param collateral Its collateral.
    /// @param condition Its condition.
    /// @param marketId Its market.
    function _record(PositionVault vault, IERC20 collateral, bytes32 condition, bytes32 marketId)
        internal
    {
        vaults.push(vault);
        created[vault] = Created(collateral, condition, marketId);
        legsOf[vault] = [IERC20(address(vault.YES())), IERC20(address(vault.NO()))];
    }

    /// @notice Mints an actor collateral and splits it.
    /// @param vault The vault.
    /// @param actor The actor.
    /// @param amount How much.
    function _split(PositionVault vault, address actor, uint256 amount) internal {
        IERC20 collateral = created[vault].collateral;
        CampaignCollateral(address(collateral)).mint(actor, amount);
        vm.startPrank(actor);
        collateral.approve(address(vault), amount);
        vault.splitPosition(amount);
        vm.stopPrank();
        split[vault] += amount;
        tally[vault][0][actor] += amount;
        tally[vault][1][actor] += amount;
        stateChangingCalls++;
    }

    /// @notice Attempts a split into a resolved vault and requires exactly the refusal the vault
    ///         owes. Should the split be accepted, it is counted like any other, so the properties see
    ///         what it minted.
    /// @param vault The resolved vault.
    /// @param actor The actor.
    /// @param amount How much.
    function _attemptLateSplit(PositionVault vault, address actor, uint256 amount) internal {
        IERC20 collateral = created[vault].collateral;
        CampaignCollateral(address(collateral)).mint(actor, amount);
        vm.prank(actor);
        collateral.approve(address(vault), amount);
        vm.prank(actor);
        (bool accepted, bytes memory reason) =
            address(vault).call(abi.encodeCall(PositionVault.splitPosition, (amount)));
        if (accepted) {
            split[vault] += amount;
            tally[vault][0][actor] += amount;
            tally[vault][1][actor] += amount;
            stateChangingCalls++;
            return;
        }
        require(
            keccak256(reason)
                == keccak256(abi.encodeWithSelector(PositionVault.MarketResolved.selector)),
            "a late split was refused for the wrong reason"
        );
    }

    /// @notice Splits into the first unresolved vault from a seed, if there is one.
    /// @param vaultSeed Where to start looking.
    /// @param actor The actor.
    /// @param amount Bounded to something a vault accepts.
    function _splitIntoAnyUnresolved(uint256 vaultSeed, address actor, uint256 amount) internal {
        for (uint256 i = 0; i < vaults.length; i++) {
            PositionVault vault = vaults[(vaultSeed % vaults.length + i) % vaults.length];
            if (!resolved(vault)) {
                _split(vault, actor, _bound(amount, 1, 1e30));
                return;
            }
        }
    }
}

/// @title ProtocolInvariantsTest
/// @notice What the core promises, over every market a campaign creates: solvency, conservation,
///         exact rounding dust, equal legs before resolution, no mint after it, final outcomes,
///         vaults that match their markets, and balances that are exactly what the calls made imply.
///         Every property reads the handler's records of what was asked for, never the protocol's
///         own account of itself.
/// @dev One invariant function reads each vault once and checks every property against that
///      reading, each with its own message: as separate functions each re-read every vault after
///      every call, which measured over ten times the campaign's time budget.
contract ProtocolInvariantsTest is Test {
    ProtocolHandler internal handler;
    MarketFactory internal factory;

    /// @notice What the properties read of one vault, once per check.
    struct Reading {
        uint256 held;
        uint256 yes;
        uint256 no;
    }

    /// @notice A factory and the handler, which creates the first market, as the only target.
    function setUp() public {
        factory = new MarketFactory();
        handler = new ProtocolHandler(factory);
        targetContract(address(handler));
    }

    /// @notice Every property, over every vault, market and condition.
    function invariant_protocol() public view {
        // A property over no vault holds vacuously.
        assertGt(handler.vaultCount(), 0, "protocol: there is no vault to check");
        for (uint256 i = 0; i < handler.vaultCount(); i++) {
            ProtocolHandler.VaultState memory state = handler.vaultState(i);
            Reading memory reading = Reading(
                state.created.collateral.balanceOf(address(state.vault)),
                state.legs[0].totalSupply(),
                state.legs[1].totalSupply()
            );
            _solvency(state, reading);
            _conservation(state, reading);
            _exactDust(state, reading);
            _equalLegsBeforeResolution(state, reading);
            _noMintAfterResolution(state, reading);
        }
        for (uint256 index = 0; index < 4; index++) {
            _outcomeIsFinal(handler.conditionAt(index));
        }
    }

    /// @notice Closes each run: the structural and ledger properties, and proof the run reached
    ///         every phase it exists to test.
    /// @dev A vault's identity is immutable, a registry entry is written once, and a balance departs
    ///      from the handler's tally only through a call that moved legs wrongly, which nothing then
    ///      undoes. None of them can go wrong and come back within a run, so checked once per run
    ///      rather than after every call they see everything a per-call check would, at a fraction
    ///      of the campaign's time. The economic properties stay per call.
    function afterInvariant() public view {
        for (uint256 i = 0; i < handler.vaultCount(); i++) {
            ProtocolHandler.VaultState memory state = handler.vaultState(i);
            _vaultMatchesItsMarket(state);
            _balancesAreWhatTheCallsImply(state, handler.talliesOf(i));
        }
        for (uint256 i = 0; i < handler.marketCount(); i++) {
            _registryIsPermanent(handler.marketIds(i));
        }
        assertGt(handler.stateChangingCalls(), 0, "the campaign changed no state");
        assertGe(handler.marketCount(), 2, "the campaign never left its first market");
        assertGt(handler.reports(), 0, "the campaign never resolved anything");
    }

    /// @notice Solvency: a vault's collateral covers what its legs can claim under the outcome
    ///         reported for its condition, or under any outcome before one is.
    /// @param state The vault's record.
    /// @param reading What it holds and its legs' supplies.
    function _solvency(ProtocolHandler.VaultState memory state, Reading memory reading)
        internal
        pure
    {
        assertGe(
            2 * reading.held,
            _doubledClaim(state.outcome, reading),
            "solvency: the legs can claim more than the vault holds"
        );
    }

    /// @notice Conservation: everything that entered a vault is accounted for; what was merged and
    ///         redeemed left it, and the rest is still there.
    /// @param state The vault's record.
    /// @param reading What it holds.
    function _conservation(ProtocolHandler.VaultState memory state, Reading memory reading)
        internal
        pure
    {
        assertEq(
            reading.held + state.merged + state.redeemed,
            state.split + state.donated,
            "conservation: collateral appeared or vanished"
        );
    }

    /// @notice Exact dust: leaving donations aside, twice what a vault holds exceeds twice what its
    ///         legs can claim by exactly the number of its redemptions whose weighted sum was odd.
    ///         Every redemption rounds down by half a unit or by nothing, and nothing else leaves dust.
    /// @param state The vault's record.
    /// @param reading What it holds and its legs' supplies.
    function _exactDust(ProtocolHandler.VaultState memory state, Reading memory reading)
        internal
        pure
    {
        assertEq(
            2 * (reading.held - state.donated),
            _doubledClaim(state.outcome, reading) + state.oddRedemptions,
            "dust: the vault holds other than its claims plus half a unit per odd redemption"
        );
    }

    /// @notice Equal legs: while a vault's condition is unresolved, its two legs have equal supply;
    ///         they are only ever created and destroyed together.
    /// @param state The vault's record.
    /// @param reading Its legs' supplies.
    function _equalLegsBeforeResolution(
        ProtocolHandler.VaultState memory state,
        Reading memory reading
    ) internal pure {
        if (state.outcome != Outcome.Unresolved) return;
        assertEq(reading.yes, reading.no, "equal legs: the legs' supplies differ");
    }

    /// @notice No mint after resolution: once a vault's condition is reported, neither leg's supply
    ///         exceeds what it was at the report, which is zero for a vault created after it.
    /// @param state The vault's record.
    /// @param reading Its legs' supplies.
    function _noMintAfterResolution(ProtocolHandler.VaultState memory state, Reading memory reading)
        internal
        pure
    {
        if (state.outcome == Outcome.Unresolved) return;
        assertLe(reading.yes, state.supplyAtReport[0], "no mint after resolution: yes was minted");
        assertLe(reading.no, state.supplyAtReport[1], "no mint after resolution: no was minted");
    }

    /// @notice A vault matches its market: its condition, collateral and market are the ones its
    ///         market was created with.
    /// @param state The vault's record.
    function _vaultMatchesItsMarket(ProtocolHandler.VaultState memory state) internal view {
        assertEq(
            state.vault.CONDITION(),
            state.created.condition,
            "markets: a vault has another condition"
        );
        assertEq(
            address(state.vault.COLLATERAL()),
            address(state.created.collateral),
            "markets: a vault has another collateral"
        );
        assertEq(
            state.vault.MARKET_ID(), state.created.marketId, "markets: a vault names another market"
        );
    }

    /// @notice Balances are what the calls imply: every actor holds exactly the legs its own
    ///         splits, merges, transfers and redemptions imply, and nobody else holds any.
    /// @param state The vault's record.
    /// @param tallies What the handler's calls imply, by leg and actor.
    function _balancesAreWhatTheCallsImply(
        ProtocolHandler.VaultState memory state,
        uint256[3][2] memory tallies
    ) internal view {
        for (uint256 leg = 0; leg < 2; leg++) {
            uint256 held;
            for (uint256 actor = 0; actor < 3; actor++) {
                uint256 balance = state.legs[leg].balanceOf(_actor(actor));
                assertEq(
                    balance,
                    tallies[leg][actor],
                    "balances: an actor holds other than its calls imply"
                );
                held += balance;
            }
            assertEq(
                state.legs[leg].totalSupply(), held, "balances: legs are held outside the actors"
            );
        }
    }

    /// @notice A market is permanent: the factory returned the id asked for, and the registry names,
    ///         under it, exactly the vaults it named at creation.
    /// @param marketId The market.
    function _registryIsPermanent(bytes32 marketId) internal view {
        assertEq(handler.returnedId(marketId), marketId, "markets: the factory returned another id");
        (PositionVault underlying, PositionVault dollar) = factory.markets(marketId);
        (PositionVault recordedUnderlying, PositionVault recordedDollar) =
            handler.recordedVaults(marketId);
        assertEq(address(underlying), address(recordedUnderlying), "markets: the registry changed");
        assertEq(address(dollar), address(recordedDollar), "markets: the registry changed");
    }

    /// @notice An outcome is final: a condition's outcome is exactly what was first reported for it,
    ///         and unresolved if nothing was.
    /// @param condition The condition.
    function _outcomeIsFinal(bytes32 condition) internal view {
        assertEq(
            uint8(factory.outcomeOf(condition)),
            uint8(handler.sent(condition)),
            "outcomes: a condition's outcome is not the one reported"
        );
    }

    /// @notice Twice what a vault's legs can claim: under a yes or a no, twice the winning leg; under
    ///         an invalid outcome, both legs; before any, twice the larger leg.
    /// @param outcome The outcome reported for the vault's condition.
    /// @param reading Its legs' supplies.
    /// @return The doubled claim.
    function _doubledClaim(Outcome outcome, Reading memory reading)
        internal
        pure
        returns (uint256)
    {
        if (outcome == Outcome.Yes) return 2 * reading.yes;
        if (outcome == Outcome.No) return 2 * reading.no;
        if (outcome == Outcome.Invalid) return reading.yes + reading.no;
        return 2 * (reading.yes > reading.no ? reading.yes : reading.no);
    }

    /// @notice The handler's actors, by index.
    /// @param index Below three.
    /// @return The actor.
    function _actor(uint256 index) internal pure returns (address) {
        return address(uint160(0x1000 * (index + 1)));
    }
}
