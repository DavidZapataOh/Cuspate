// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {FreezeHook} from "../../src/FreezeHook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {PositionRouter} from "../../src/PositionRouter.sol";
import {Outcome, PositionVault} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {IPermit2Calls, IPositionManagerCalls} from "./ConditionalPoolsFork.t.sol";
import {BatchAccount} from "./PositionRouterFork.t.sol";

/// @notice The part of the deployed position manager this test reads a position's range from, and
///         its record of a position's owner.
interface IPositionReads {
    /// @notice A position's pool and its packed range.
    /// @param tokenId The position.
    /// @return poolKey Its pool.
    /// @return info Its packed range: the lower tick at bits 8 to 31, the upper at 32 to 55.
    function getPoolAndPositionInfo(uint256 tokenId)
        external
        view
        returns (PoolKey memory poolKey, uint256 info);

    /// @notice A position's owner; reverts for a burned position.
    /// @param tokenId The position.
    /// @return The owner.
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title LiquidityLifecycleForkTest
/// @notice The protocol's liquidity through a market's whole life, on the venue as deployed at a
///         pinned block, and every unit of it accounted. The provider, a batch account, opens and
///         seeds the three pools of a capped market in one atomic batch; traders enter, exit and
///         swap; the market freezes; the provider burns every position in one call, merges its
///         matched legs, the event resolves, and the remainder is redeemed in one call per vault.
///         Every burn pays exactly principal plus fees; per leg, what the provider receives is
///         exactly its deposit plus the traders' net input less the rounding the manager keeps; and
///         the collateral each side ends with is the closed form of the outcome.
contract LiquidityLifecycleForkTest is Test {
    using PoolIdLibrary for PoolKey;

    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    /// @notice The hook's address: exactly the before-initialise and before-swap permissions.
    address internal constant HOOK =
        address(uint160(0x4444 << 144) | Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    /// @notice The position manager's action codes.
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant BURN_POSITION = 0x03;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    uint8 internal constant TAKE_PAIR = 0x11;

    /// @notice Each pool's liquidity, and the range's half-width (a fifth either side).
    uint128 internal constant CONDITIONAL_LIQUIDITY = 1e16;
    uint128 internal constant PROBABILITY_LIQUIDITY = 1e11;
    int24 internal constant HALF_WIDTH = 1823;

    /// @notice The provider's split of each collateral, and the room left for traders' dollars.
    uint256 internal constant SEED_SHARES = 30e18;
    uint256 internal constant SEED_DOLLARS = 45_000e6;
    uint256 internal constant TRADER_ROOM = 1_000e6;

    /// @notice How far from the intended price a mint may still go through: one part in a thousand.
    uint256 internal constant TOLERANCE = 1e3;

    address internal owner = makeAddr("provider owner");
    address internal sealer = makeAddr("sealer");
    address internal guardian = makeAddr("guardian");
    address internal trader = makeAddr("trader");
    address internal proposer = makeAddr("proposer");
    address internal stranger = makeAddr("stranger");

    IPoolManager internal manager;
    IPositionManagerCalls internal positions;
    IPermit2Calls internal permit2;
    PoolSwapTest internal swapRouter;
    IERC20 internal underlying;
    IERC20 internal dollar;
    MarketFactory internal factory;
    ThresholdRegistry internal registry;
    OptimisticResolver internal resolver;
    FreezeHook internal hook;
    PositionRouter internal router;
    BatchAccount internal provider;

    bytes32 internal eventId;
    uint64 internal announcesAt;
    bytes32 internal marketId;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;
    PoolKey[3] internal keys;
    uint160[3] internal targets;
    uint256[3] internal tokenIds;
    /// @notice The four legs: the underlying's yes and no, the dollar's yes and no.
    address[4] internal legs;
    /// @notice Per leg: the provider's deposit at mint, the manager's balance after seeding and
    ///         after trading.
    uint256[4] internal deposited;
    uint256[4] internal managerAfterSeeding;
    uint256[4] internal managerAfterTrading;

    /// @notice A sealed event, a capped market on it, the hook, the router, the resolver with short
    ///         clocks, and a provider holding only the collateral it will split.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);
        manager = IPoolManager(AddressBook.thirdParty("poolManager", 0));
        positions = IPositionManagerCalls(AddressBook.thirdParty("positionManager", 0));
        permit2 = IPermit2Calls(AddressBook.thirdParty("permit2", 0));
        underlying = IERC20(AddressBook.thirdParty("collateral", 0));
        dollar = IERC20(AddressBook.thirdParty("dollar", 0));
        assertEq(block.number, pinned, "not at the pinned block");
        assertGt(
            address(manager).code.length * address(positions).code.length
                * address(dollar).code.length,
            0,
            "no code at a recorded contract at the pinned block: if the endpoint no longer serves "
            "this block, re-pin it; the assertion itself is not what failed"
        );

        factory = new MarketFactory();
        registry = new ThresholdRegistry();
        resolver = new OptimisticResolver(
            factory, registry, sealer, makeAddr("arbiter"), dollar, 2, 1, 1, 1, 1
        );
        deployCodeTo("FreezeHook.sol:FreezeHook", abi.encode(manager, resolver, guardian), HOOK);
        hook = FreezeHook(HOOK);
        router = new PositionRouter(hook);
        swapRouter = new PoolSwapTest(manager);

        announcesAt = uint64(vm.getBlockTimestamp()) + 1 days;
        vm.prank(sealer);
        eventId = registry.seal(
            ThresholdRegistry.Threshold({
                value: 1,
                decimals: 0,
                announcesAt: announcesAt,
                deadline: announcesAt + 1 days,
                terms: "life"
            })
        );
        marketId = factory.createMarket(
            underlying, dollar, eventId, address(resolver), SEED_SHARES, SEED_DOLLARS + TRADER_ROOM
        );
        (underlyingVault, dollarVault) = factory.markets(marketId);
        (keys[0], keys[1]) = ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(HOOK));
        keys[2] = ConditionalPools.probabilityKeyOf(dollarVault, IHooks(HOOK));
        targets = [
            ConditionalPools.sqrtPriceX96(
                keys[0], IERC20Metadata(address(underlyingVault.YES())), 1040, 0
            ),
            ConditionalPools.sqrtPriceX96(
                keys[1], IERC20Metadata(address(underlyingVault.NO())), 960, 0
            ),
            ConditionalPools.sqrtPriceAtYesDollarPrice(dollarVault, 0.6e18)
        ];
        legs = [
            address(underlyingVault.YES()),
            address(underlyingVault.NO()),
            address(dollarVault.YES()),
            address(dollarVault.NO())
        ];

        provider = new BatchAccount(owner);
        deal(address(underlying), address(provider), SEED_SHARES);
        deal(address(dollar), address(provider), SEED_DOLLARS);
    }

    /// @notice Yes: the yes pool's legs redeem in full, the no pool's for nothing.
    function testFork_aYesLifecycle() public {
        _lifecycle(Outcome.Yes, false);
    }

    /// @notice No: the reverse.
    function testFork_aNoLifecycle() public {
        _lifecycle(Outcome.No, false);
    }

    /// @notice Invalid: every leg for half.
    function testFork_anInvalidLifecycle() public {
        _lifecycle(Outcome.Invalid, false);
    }

    /// @notice Burning after resolution gains nothing — the pools are frozen — but still works.
    function testFork_aBurnLeftUntilAfterResolution() public {
        _lifecycle(Outcome.Yes, true);
    }

    /// @notice The guardian's path: the freeze brought forward, every position burned and the
    ///         matched legs merged back into collateral, with no resolution needed for that part.
    function testFork_theGuardiansPath() public {
        _seed();
        _trade();
        vm.prank(guardian);
        hook.freezeNow(marketId);
        _withdraw();
        (uint256 sharesBack, uint256 dollarsBack) = _mergeMatched();
        assertGt(sharesBack, 0);
        assertGt(dollarsBack, 0);
        assertEq(underlying.balanceOf(address(provider)), sharesBack);
        assertEq(dollar.balanceOf(address(provider)), dollarsBack);
    }

    /// @notice A stranger who opens a pool first only makes the seeding batch revert whole; a batch
    ///         that mints at the moved price is refused by the mint's maxima; and a batch that
    ///         restores the price first, then mints, goes through.
    function testFork_aStrangersOpeningOnlyRevertsTheBatch() public {
        // Opened one part in a hundred away from the value.
        uint160 moved = uint160(FullMath.mulDiv(targets[0], 1005, 1000));
        // The hook admits no pool of an unregistered market, so the stranger registers it first;
        // registration is open to anyone and idempotent, so the provider's batch repeats it harmlessly.
        vm.startPrank(stranger);
        hook.register(marketId, eventId);
        manager.initialize(keys[0], moved);
        vm.stopPrank();
        BatchAccount.Call[] memory seeding = _seedingBatch(true);
        vm.expectRevert(Pool.PoolAlreadyInitialized.selector);
        vm.prank(owner);
        provider.execute(seeding);

        BatchAccount.Call[] memory unrestored = _seedingBatch(false);
        vm.expectPartialRevert(bytes4(keccak256("MaximumAmountExceeded(uint128,uint128)")));
        vm.prank(owner);
        provider.execute(unrestored);

        BatchAccount.Call[] memory restored = _restoringBatch();
        vm.prank(owner);
        provider.execute(restored);
        (uint160 price,,,) = StateLibrary.getSlot0(manager, keys[0].toId());
        assertEq(price, targets[0], "the restore did not reach the value");
        assertEq(positions.getPositionLiquidity(tokenIds[0]), CONDITIONAL_LIQUIDITY);
    }

    /// @notice The cap holds through the life: once seeded and traded, a split of the room left
    ///         plus one is refused; after the burn and the merge, room is free again.
    function testFork_theCapHoldsAndMergingFreesRoom() public {
        _seed();
        _trade();
        uint256 room = dollarVault.CAP() - dollarVault.YES().totalSupply();
        address late = makeAddr("late splitter");
        deal(address(dollar), late, room + 1);
        vm.startPrank(late);
        dollar.approve(address(dollarVault), room + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionVault.CapExceeded.selector,
                dollarVault.CAP(),
                dollarVault.CAP() - room,
                room + 1
            )
        );
        dollarVault.splitPosition(room + 1);
        vm.stopPrank();
        vm.warp(announcesAt);
        _withdraw();
        (, uint256 dollarsBack) = _mergeMatched();
        assertEq(
            dollarVault.CAP() - dollarVault.YES().totalSupply(),
            room + dollarsBack,
            "merging freed no room"
        );
    }

    /// @notice The whole life for one outcome, and every account closed.
    /// @param outcome How the event resolves.
    /// @param burnAfterResolution Whether the positions are burned only after resolution.
    function _lifecycle(Outcome outcome, bool burnAfterResolution) internal {
        _seed();
        _trade();
        vm.warp(announcesAt);
        if (burnAfterResolution) {
            _resolve(outcome);
            _withdraw();
            _mergeMatched();
        } else {
            _withdraw();
            _mergeMatched();
            _resolve(outcome);
        }
        _redeemAndClose(outcome);
    }

    /// @notice Opens and seeds the three pools in one atomic batch, recording the deposits and the
    ///         manager's balances.
    function _seed() internal {
        BatchAccount.Call[] memory calls = _seedingBatch(true);
        vm.prank(owner);
        provider.execute(calls);
        for (uint256 leg = 0; leg < 4; leg++) {
            // The legs are new: the manager held none, so what it holds now is the deposits.
            managerAfterSeeding[leg] = IERC20(legs[leg]).balanceOf(address(manager));
            deposited[leg] = managerAfterSeeding[leg];
        }
        for (uint256 index = 0; index < 3; index++) {
            (uint160 price,,,) = StateLibrary.getSlot0(manager, keys[index].toId());
            assertEq(price, targets[index], "a pool did not open at its value");
        }
    }

    /// @notice The seeding batch: register, open the three pools (or not), split both collaterals,
    ///         approve the legs through Permit2, and mint the three positions with maxima at the
    ///         intended prices plus the tolerance.
    /// @param open Whether the batch opens the pools itself.
    /// @return calls The batch.
    function _seedingBatch(bool open) internal returns (BatchAccount.Call[] memory calls) {
        calls = new BatchAccount.Call[](open ? 19 : 16);
        uint256 next = 0;
        calls[next++] = BatchAccount.Call(
            address(hook), abi.encodeCall(FreezeHook.register, (marketId, eventId))
        );
        if (open) {
            for (uint256 index = 0; index < 3; index++) {
                calls[next++] = BatchAccount.Call(
                    address(manager),
                    abi.encodeCall(IPoolManager.initialize, (keys[index], targets[index]))
                );
            }
        }
        next = _splitCalls(calls, next);
        next = _approvalCalls(calls, next);
        uint256 first = positions.nextTokenId();
        for (uint256 index = 0; index < 3; index++) {
            tokenIds[index] = first + index;
            calls[next++] = BatchAccount.Call(address(positions), _mintCall(index));
        }
    }

    /// @notice The batch for pools a stranger opened first: the yes pool restored to its value by a
    ///         swap against no liquidity, the other two opened, then the same splits, approvals and
    ///         mints.
    /// @return calls The batch.
    function _restoringBatch() internal returns (BatchAccount.Call[] memory calls) {
        calls = new BatchAccount.Call[](19);
        uint256 next = 0;
        calls[next++] = BatchAccount.Call(
            address(hook), abi.encodeCall(FreezeHook.register, (marketId, eventId))
        );
        (uint160 current,,,) = StateLibrary.getSlot0(manager, keys[0].toId());
        calls[next++] = BatchAccount.Call(
            address(swapRouter),
            abi.encodeCall(
                PoolSwapTest.swap,
                (
                    keys[0],
                    IPoolManager.SwapParams({
                        zeroForOne: current > targets[0],
                        amountSpecified: -1,
                        sqrtPriceLimitX96: targets[0]
                    }),
                    PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                    bytes("")
                )
            )
        );
        for (uint256 index = 1; index < 3; index++) {
            calls[next++] = BatchAccount.Call(
                address(manager),
                abi.encodeCall(IPoolManager.initialize, (keys[index], targets[index]))
            );
        }
        next = _splitCalls(calls, next);
        next = _approvalCalls(calls, next);
        uint256 first = positions.nextTokenId();
        for (uint256 index = 0; index < 3; index++) {
            tokenIds[index] = first + index;
            calls[next++] = BatchAccount.Call(address(positions), _mintCall(index));
        }
    }

    /// @notice Appends the provider's approval and split of each collateral.
    /// @param calls The batch.
    /// @param next Where to write.
    /// @return The next free slot.
    function _splitCalls(BatchAccount.Call[] memory calls, uint256 next)
        internal
        view
        returns (uint256)
    {
        calls[next++] = BatchAccount.Call(
            address(underlying),
            abi.encodeCall(IERC20.approve, (address(underlyingVault), SEED_SHARES))
        );
        calls[next++] = BatchAccount.Call(
            address(underlyingVault), abi.encodeCall(PositionVault.splitPosition, (SEED_SHARES))
        );
        calls[next++] = BatchAccount.Call(
            address(dollar), abi.encodeCall(IERC20.approve, (address(dollarVault), SEED_DOLLARS))
        );
        calls[next++] = BatchAccount.Call(
            address(dollarVault), abi.encodeCall(PositionVault.splitPosition, (SEED_DOLLARS))
        );
        return next;
    }

    /// @notice Appends, for each leg, its approval to Permit2 and Permit2's to the position manager.
    /// @param calls The batch.
    /// @param next Where to write.
    /// @return The next free slot.
    function _approvalCalls(BatchAccount.Call[] memory calls, uint256 next)
        internal
        view
        returns (uint256)
    {
        for (uint256 leg = 0; leg < 4; leg++) {
            calls[next++] = BatchAccount.Call(
                legs[leg], abi.encodeCall(IERC20.approve, (address(permit2), type(uint256).max))
            );
            calls[next++] = BatchAccount.Call(
                address(permit2),
                abi.encodeCall(
                    IPermit2Calls.approve,
                    (legs[leg], address(positions), type(uint160).max, type(uint48).max)
                )
            );
        }
        return next;
    }

    /// @notice One pool's mint, a fifth either side of its value, its maxima the amounts at the
    ///         value plus the tolerance — the only price check the provider needs.
    /// @param index The pool.
    /// @return The call to the position manager.
    function _mintCall(uint256 index) internal view returns (bytes memory) {
        PoolKey memory key = keys[index];
        uint128 liquidity = index == 2 ? PROBABILITY_LIQUIDITY : CONDITIONAL_LIQUIDITY;
        int24 tick = TickMath.getTickAtSqrtPrice(targets[index]);
        int24 lower = _floor(tick - HALF_WIDTH);
        int24 upper = _floor(tick + HALF_WIDTH) + ConditionalPools.TICK_SPACING;
        uint256 max0 = SqrtPriceMath.getAmount0Delta(
            targets[index], TickMath.getSqrtPriceAtTick(upper), liquidity, true
        );
        uint256 max1 = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(lower), targets[index], liquidity, true
        );
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            lower,
            upper,
            uint256(liquidity),
            SafeCast.toUint128(max0 + max0 / TOLERANCE),
            SafeCast.toUint128(max1 + max1 / TOLERANCE),
            address(provider),
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        return abi.encodeCall(
            IPositionManagerCalls.modifyLiquidities,
            (
                abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), params),
                vm.getBlockTimestamp()
            )
        );
    }

    /// @notice The named trades: an entry in each world through the router, the yes position exited
    ///         levelled in the probability pool, and a direct swap in the probability pool.
    function _trade() internal {
        deal(address(dollar), trader, 400e6);
        vm.startPrank(trader);
        dollar.approve(address(router), 400e6);
        uint256 shares = router.enter(marketId, true, 200e6, 1, trader, vm.getBlockTimestamp());
        router.enter(marketId, false, 200e6, 1, trader, vm.getBlockTimestamp());
        IERC20(legs[0]).approve(address(router), shares);
        IERC20(legs[3]).approve(address(router), 200e6);
        router.exit(
            PositionRouter.ExitOrder({
                marketId: marketId,
                yes: true,
                shares: shares,
                kept: 200e6,
                minOut: 1,
                levelSellsWorldDollar: false,
                level: 1e6,
                minLevelOut: 1,
                recipient: trader,
                deadline: vm.getBlockTimestamp()
            })
        );
        IERC20(legs[2]).approve(address(swapRouter), 50e6);
        bool zeroForOne = Currency.unwrap(keys[2].currency0) == legs[2];
        swapRouter.swap(
            keys[2],
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -50e6,
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        for (uint256 leg = 0; leg < 4; leg++) {
            managerAfterTrading[leg] = IERC20(legs[leg]).balanceOf(address(manager));
        }
    }

    /// @notice Reads each position's principal and fees, then burns all three and takes both pairs
    ///         in one call, and checks per leg: the provider receives exactly principal plus fees
    ///         over the pools carrying the leg, which is its deposit plus the traders' net input less
    ///         the rounding the manager keeps.
    function _withdraw() internal {
        uint256[4] memory owed;
        for (uint256 index = 0; index < 3; index++) {
            (uint256 owed0, uint256 owed1) = _owed(index);
            owed[_legIndex(Currency.unwrap(keys[index].currency0))] += owed0;
            owed[_legIndex(Currency.unwrap(keys[index].currency1))] += owed1;
        }
        uint256[4] memory before;
        for (uint256 leg = 0; leg < 4; leg++) {
            before[leg] = IERC20(legs[leg]).balanceOf(address(provider));
        }
        BatchAccount.Call[] memory calls = new BatchAccount.Call[](1);
        calls[0] = BatchAccount.Call(address(positions), _burnCall());
        vm.prank(owner);
        provider.execute(calls);

        for (uint256 index = 0; index < 3; index++) {
            assertEq(
                StateLibrary.getLiquidity(manager, keys[index].toId()), 0, "a pool kept liquidity"
            );
            vm.expectRevert();
            IPositionReads(address(positions)).ownerOf(tokenIds[index]);
        }
        for (uint256 leg = 0; leg < 4; leg++) {
            uint256 received = IERC20(legs[leg]).balanceOf(address(provider)) - before[leg];
            uint256 left = IERC20(legs[leg]).balanceOf(address(manager));
            assertEq(received, owed[leg], "a burn paid other than principal plus fees");
            assertEq(
                received + left,
                managerAfterTrading[leg],
                "the provider and the manager's rounding are not what the pools held"
            );
            assertEq(
                SafeCast.toInt256(received),
                SafeCast.toInt256(deposited[leg])
                    + (SafeCast.toInt256(managerAfterTrading[leg])
                        - SafeCast.toInt256(managerAfterSeeding[leg])) - SafeCast.toInt256(left),
                "the provider's credit is not its deposit plus the traders' net input less the rounding"
            );
            // Measured at the pinned block, the same in every scenario here: the rounding v4 keeps in its
            // own favour over the seeding, the trades and the burns that touched each leg.
            assertEq(left, [uint256(3), 2, 4, 4][leg], "the manager kept other than its rounding");
        }
    }

    /// @notice One position's principal at the current price and its fees from fee growth, read
    ///         with nothing between them and the burn.
    /// @param index The pool.
    /// @return owed0 What the burn owes in the pool's first currency.
    /// @return owed1 And in its second.
    function _owed(uint256 index) internal view returns (uint256 owed0, uint256 owed1) {
        (int24 lower, int24 upper) = _rangeOf(tokenIds[index]);
        (uint256 fees0, uint256 fees1, uint128 liquidity) = _fees(index, lower, upper);
        (uint256 principal0, uint256 principal1) = _principal(index, lower, upper, liquidity);
        return (principal0 + fees0, principal1 + fees1);
    }

    /// @notice A position's range, from the position manager's packed record.
    /// @param tokenId The position.
    /// @return lower Its lower tick.
    /// @return upper Its upper tick.
    function _rangeOf(uint256 tokenId) internal view returns (int24 lower, int24 upper) {
        (, uint256 info) = IPositionReads(address(positions)).getPoolAndPositionInfo(tokenId);
        // forge-lint: disable-next-line(unsafe-typecast)
        lower = int24(uint24(info >> 8));
        // forge-lint: disable-next-line(unsafe-typecast)
        upper = int24(uint24(info >> 32));
    }

    /// @notice A position's fees owed, from the pool's fee growth inside its range since the
    ///         position last collected, and its liquidity.
    /// @param index The pool.
    /// @param lower The lower tick.
    /// @param upper The upper tick.
    /// @return fees0 In the first currency.
    /// @return fees1 In the second.
    /// @return liquidity The position's liquidity.
    function _fees(uint256 index, int24 lower, int24 upper)
        internal
        view
        returns (uint256 fees0, uint256 fees1, uint128 liquidity)
    {
        PoolId id = keys[index].toId();
        uint256 last0;
        uint256 last1;
        (liquidity, last0, last1) = StateLibrary.getPositionInfo(
            manager, id, address(positions), lower, upper, bytes32(tokenIds[index])
        );
        (uint256 growth0, uint256 growth1) =
            StateLibrary.getFeeGrowthInside(manager, id, lower, upper);
        unchecked {
            fees0 = FullMath.mulDiv(growth0 - last0, liquidity, 1 << 128);
            fees1 = FullMath.mulDiv(growth1 - last1, liquidity, 1 << 128);
        }
    }

    /// @notice A position's principal at the pool's current price, as the pool computes a removal:
    ///         all in the first currency below the range, both inside it, all in the second above,
    ///         rounded down.
    /// @param index The pool.
    /// @param lower The lower tick.
    /// @param upper The upper tick.
    /// @param liquidity The position's liquidity.
    /// @return principal0 In the first currency.
    /// @return principal1 In the second.
    function _principal(uint256 index, int24 lower, int24 upper, uint128 liquidity)
        internal
        view
        returns (uint256 principal0, uint256 principal1)
    {
        (uint160 price, int24 tick,,) = StateLibrary.getSlot0(manager, keys[index].toId());
        (uint160 sqrtA, uint160 sqrtB) =
            (TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper));
        if (tick < lower) {
            principal0 = SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, false);
        } else if (tick < upper) {
            principal0 = SqrtPriceMath.getAmount0Delta(price, sqrtB, liquidity, false);
            principal1 = SqrtPriceMath.getAmount1Delta(sqrtA, price, liquidity, false);
        } else {
            principal1 = SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, false);
        }
    }

    /// @notice One call to the position manager: burn all three positions, then take both pairs,
    ///         which between them carry all four legs.
    /// @return The call.
    function _burnCall() internal view returns (bytes memory) {
        bytes[] memory params = new bytes[](5);
        for (uint256 index = 0; index < 3; index++) {
            params[index] = abi.encode(tokenIds[index], uint128(0), uint128(0), bytes(""));
        }
        params[3] = abi.encode(keys[0].currency0, keys[0].currency1, address(provider));
        params[4] = abi.encode(keys[1].currency0, keys[1].currency1, address(provider));
        return abi.encodeCall(
            IPositionManagerCalls.modifyLiquidities,
            (
                abi.encode(
                    abi.encodePacked(
                        BURN_POSITION, BURN_POSITION, BURN_POSITION, TAKE_PAIR, TAKE_PAIR
                    ),
                    params
                ),
                vm.getBlockTimestamp()
            )
        );
    }

    /// @notice Merges the provider's matched legs back into collateral, in one batch.
    /// @return sharesBack The underlying merged.
    /// @return dollarsBack The dollars merged.
    function _mergeMatched() internal returns (uint256 sharesBack, uint256 dollarsBack) {
        sharesBack = _min(
            IERC20(legs[0]).balanceOf(address(provider)),
            IERC20(legs[1]).balanceOf(address(provider))
        );
        dollarsBack = _min(
            IERC20(legs[2]).balanceOf(address(provider)),
            IERC20(legs[3]).balanceOf(address(provider))
        );
        BatchAccount.Call[] memory calls = new BatchAccount.Call[](2);
        calls[0] = BatchAccount.Call(
            address(underlyingVault), abi.encodeCall(PositionVault.mergePositions, (sharesBack))
        );
        calls[1] = BatchAccount.Call(
            address(dollarVault), abi.encodeCall(PositionVault.mergePositions, (dollarsBack))
        );
        vm.prank(owner);
        provider.execute(calls);
    }

    /// @notice Resolves the event through the resolver: a figure above the threshold for yes, below
    ///         for no, or invalid once the deadline has passed.
    /// @param outcome The outcome.
    function _resolve(Outcome outcome) internal {
        deal(address(dollar), proposer, 2);
        vm.startPrank(proposer);
        dollar.approve(address(resolver), 2);
        if (outcome == Outcome.Invalid) {
            vm.warp(announcesAt + 1 days + 1);
            resolver.proposeInvalid(eventId);
        } else {
            vm.warp(vm.getBlockTimestamp() > announcesAt ? vm.getBlockTimestamp() : announcesAt);
            resolver.proposeFigure(eventId, outcome == Outcome.Yes ? int256(2) : int256(0), 0);
        }
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1);
        resolver.settle(eventId);
        assertEq(
            uint8(factory.outcomeOf(dollarVault.CONDITION())),
            uint8(outcome),
            "the event did not resolve"
        );
    }

    /// @notice Redeems the provider's remainder in one call per vault and the traders' legs, then
    ///         checks the closed form of the outcome and that each collateral is conserved.
    /// @param outcome The outcome.
    function _redeemAndClose(Outcome outcome) internal {
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        IERC20[2] memory collaterals = [underlying, dollar];
        for (uint256 index = 0; index < 2; index++) {
            uint256 heldYes = IERC20(legs[2 * index]).balanceOf(address(provider));
            uint256 heldNo = IERC20(legs[2 * index + 1]).balanceOf(address(provider));
            uint256 collateralBefore = collaterals[index].balanceOf(address(provider));
            BatchAccount.Call[] memory calls = new BatchAccount.Call[](1);
            calls[0] = BatchAccount.Call(
                address(vaults[index]),
                abi.encodeCall(PositionVault.redeemPositions, (heldYes, heldNo))
            );
            vm.prank(owner);
            provider.execute(calls);
            uint256 redeemed = collaterals[index].balanceOf(address(provider)) - collateralBefore;
            // The matched part was merged, so one of the two is zero, and the closed form is exact.
            uint256 expected = outcome == Outcome.Yes
                ? heldYes
                : outcome == Outcome.No ? heldNo : (heldYes + heldNo) / 2;
            assertEq(
                redeemed, expected, "the remainder did not redeem at the outcome's closed form"
            );
            for (uint256 leg = 2 * index; leg < 2 * index + 2; leg++) {
                assertEq(
                    IERC20(legs[leg]).balanceOf(address(provider)), 0, "the provider kept a leg"
                );
            }

            uint256 traderYes = IERC20(legs[2 * index]).balanceOf(trader);
            uint256 traderNo = IERC20(legs[2 * index + 1]).balanceOf(trader);
            vm.prank(trader);
            vaults[index].redeemPositions(traderYes, traderNo);
        }
        // Conserved per collateral: everything split in came out to the provider and the trader, or
        // stays in the vault backing the legs the manager kept as rounding.
        assertEq(
            SEED_SHARES,
            underlying.balanceOf(address(provider)) + underlying.balanceOf(trader)
                + underlying.balanceOf(address(underlyingVault)),
            "the underlying is not conserved"
        );
        assertEq(
            SEED_DOLLARS + 400e6,
            dollar.balanceOf(address(provider)) + dollar.balanceOf(trader)
                + dollar.balanceOf(address(dollarVault)),
            "the dollar is not conserved"
        );
    }

    /// @notice A leg's index among the four.
    /// @param leg The leg.
    /// @return The index.
    function _legIndex(address leg) internal view returns (uint256) {
        for (uint256 index = 0; index < 4; index++) {
            if (legs[index] == leg) return index;
        }
        revert("not a leg of this market");
    }

    /// @notice The smaller of two amounts.
    /// @param a One.
    /// @param b The other.
    /// @return The smaller.
    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice A tick rounded down to the spacing.
    /// @param tick The tick.
    /// @return The rounded tick.
    function _floor(int24 tick) internal pure returns (int24) {
        int24 spacing = ConditionalPools.TICK_SPACING;
        return tick / spacing * spacing - (tick % spacing < 0 ? spacing : int24(0));
    }
}
