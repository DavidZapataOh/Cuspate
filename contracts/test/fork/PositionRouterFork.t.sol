// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {PositionRouter} from "../../src/PositionRouter.sol";
import {FreezeHook} from "../../src/FreezeHook.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {OptimisticResolver} from "../../src/OptimisticResolver.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {ThresholdRegistry} from "../../src/ThresholdRegistry.sol";
import {IQuoterCalls} from "./ConditionalPoolsFork.t.sol";

/// @notice The least a smart account does: its owner signs one transaction that runs a batch of calls
///         from the account, all or nothing. It stands in for the embedded wallet's account, whose
///         real type is proven elsewhere.
contract BatchAccount {
    /// @notice One call of a batch.
    /// @param target The contract called.
    /// @param data The calldata.
    struct Call {
        address target;
        bytes data;
    }

    /// @notice Who may run a batch.
    address public immutable OWNER;

    /// @notice Records the owner.
    /// @param owner The owner.
    constructor(address owner) {
        OWNER = owner;
    }

    /// @notice Runs every call in order from this account, reverting with the first failure's data.
    /// @param calls The batch.
    function execute(Call[] calldata calls) external {
        require(msg.sender == OWNER, "not the owner");
        for (uint256 index = 0; index < calls.length; index++) {
            (bool success, bytes memory result) = calls[index].target.call(calls[index].data);
            if (!success) {
                assembly ("memory-safe") {
                    revert(add(result, 32), mload(result))
                }
            }
        }
    }
}

/// @title PositionRouterForkTest
/// @notice On the venue as deployed at a pinned block, with the real dollar: an account holding only
///         dollars enters a conditional position with one transaction its owner signs once — the
///         dollar's approval and the entry in one batch — and receives exactly what the deployed
///         quoter quotes, plus every dollar it paid as the other world's dollar leg.
contract PositionRouterForkTest is Test {
    using PoolIdLibrary for PoolKey;

    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    /// @notice The hook's address: exactly the before-initialise and before-swap permissions.
    address internal constant HOOK =
        address(uint160(0x4444 << 144) | Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    /// @notice A hundred dollars, in the dollar's six decimals.
    uint256 internal constant DOLLARS = 100e6;

    address internal owner = makeAddr("owner");
    address internal sealer = makeAddr("sealer");

    IPoolManager internal manager;
    IQuoterCalls internal quoter;
    IERC20 internal underlying;
    IERC20 internal dollar;
    PositionRouter internal router;
    BatchAccount internal account;

    bytes32 internal marketId;
    uint64 internal announcesAt;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;
    PoolKey internal yesKey;

    /// @notice A sealed, registered market over the real underlying and dollar, its pools open at
    ///         1,040 and 960 dollars a share and seeded, the router, and an account holding only
    ///         dollars.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);
        manager = IPoolManager(AddressBook.thirdParty("poolManager", 0));
        quoter = IQuoterCalls(AddressBook.thirdParty("v4Quoter", 0));
        underlying = IERC20(AddressBook.thirdParty("collateral", 0));
        dollar = IERC20(AddressBook.thirdParty("dollar", 0));
        assertEq(block.number, pinned, "not at the pinned block");
        assertGt(
            address(manager).code.length * address(quoter).code.length
                * address(dollar).code.length,
            0,
            "no code at a recorded contract at the pinned block: if the endpoint no longer serves "
            "this block, re-pin it; the assertion itself is not what failed"
        );

        MarketFactory factory = new MarketFactory();
        ThresholdRegistry registry = new ThresholdRegistry();
        OptimisticResolver resolver = new OptimisticResolver(
            factory, registry, sealer, makeAddr("arbiter"), dollar, 1, 1, 1, 1, 1
        );
        deployCodeTo(
            "FreezeHook.sol:FreezeHook", abi.encode(manager, resolver, makeAddr("guardian")), HOOK
        );
        announcesAt = uint64(vm.getBlockTimestamp()) + 1 days;
        vm.prank(sealer);
        bytes32 eventId = registry.seal(
            ThresholdRegistry.Threshold({
                value: 1,
                decimals: 0,
                announcesAt: announcesAt,
                deadline: announcesAt + 1 days,
                terms: "e"
            })
        );
        marketId = factory.createMarket(underlying, dollar, eventId, address(resolver));
        FreezeHook(HOOK).register(underlying, dollar, eventId);
        (underlyingVault, dollarVault) = factory.markets(marketId);
        PoolKey memory noKey;
        (yesKey, noKey) = ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(HOOK));
        _seed(yesKey, address(underlyingVault.YES()), 1040);
        _seed(noKey, address(underlyingVault.NO()), 960);

        router = new PositionRouter(FreezeHook(HOOK));
        account = new BatchAccount(owner);
        deal(address(dollar), address(account), DOLLARS);
    }

    /// @notice One signed transaction, from an account holding only dollars: it ends holding the yes
    ///         share the deployed quoter quoted for its yes-dollars and every no-dollar it paid, with
    ///         no dollar and no allowance left; the router holds nothing.
    function testFork_anAccountHoldingOnlyDollarsEntersInOneTransaction() public {
        assertEq(underlyingVault.YES().balanceOf(address(account)), 0);
        assertEq(dollarVault.NO().balanceOf(address(account)), 0);
        bool zeroForOne = Currency.unwrap(yesKey.currency0) == address(dollarVault.YES());
        (uint256 quoted,) = quoter.quoteExactInputSingle(
            IQuoterCalls.QuoteExactSingleParams(yesKey, zeroForOne, uint128(DOLLARS), "")
        );

        vm.prank(owner);
        account.execute(_batch(quoted));

        assertEq(
            underlyingVault.YES().balanceOf(address(account)), quoted, "the share is not the quote"
        );
        assertEq(
            dollarVault.NO().balanceOf(address(account)),
            DOLLARS,
            "the dollars kept are not those paid"
        );
        assertEq(dollar.balanceOf(address(account)), 0);
        assertEq(dollar.allowance(address(account), address(router)), 0, "an allowance was left");
        assertEq(dollar.balanceOf(address(router)), 0);
        assertEq(dollarVault.YES().balanceOf(address(router)), 0);
        assertEq(dollarVault.NO().balanceOf(address(router)), 0);
    }

    /// @notice From the freeze the same transaction reverts whole, with the hook's error inside the
    ///         manager's, and the account keeps its dollars.
    function testFork_theSameTransactionRevertsAtTheFreeze() public {
        vm.warp(announcesAt);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                HOOK,
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(FreezeHook.Frozen.selector, yesKey.toId(), announcesAt),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        vm.prank(owner);
        account.execute(_batch(1));
        assertEq(dollar.balanceOf(address(account)), DOLLARS);
    }

    /// @notice The batch: approve exactly the dollars, then enter the yes world for the account.
    /// @param minShares The floor.
    /// @return calls The batch.
    function _batch(uint256 minShares) internal view returns (BatchAccount.Call[] memory calls) {
        calls = new BatchAccount.Call[](2);
        calls[0] = BatchAccount.Call(
            address(dollar), abi.encodeCall(IERC20.approve, (address(router), DOLLARS))
        );
        calls[1] = BatchAccount.Call(
            address(router),
            abi.encodeCall(
                PositionRouter.enter,
                (marketId, true, DOLLARS, minShares, address(account), vm.getBlockTimestamp())
            )
        );
    }

    /// @notice Opens a pool at a share's value and seeds it a fifth either side from fabricated
    ///         collateral.
    /// @param key The pool.
    /// @param share The underlying leg in it.
    /// @param value The share's value in whole dollars.
    function _seed(PoolKey memory key, address share, uint256 value) internal {
        PoolModifyLiquidityTest seeder = new PoolModifyLiquidityTest(manager);
        PositionVault[2] memory vaults = [underlyingVault, dollarVault];
        uint256[2] memory amounts = [uint256(100e18), 200_000e6];
        for (uint256 index = 0; index < 2; index++) {
            IERC20 collateral = vaults[index].COLLATERAL();
            deal(address(collateral), address(this), amounts[index]);
            collateral.approve(address(vaults[index]), amounts[index]);
            vaults[index].splitPosition(amounts[index]);
            vaults[index].YES().approve(address(seeder), type(uint256).max);
            vaults[index].NO().approve(address(seeder), type(uint256).max);
        }
        int24 tick = manager.initialize(
            key, ConditionalPools.sqrtPriceX96(key, IERC20Metadata(share), value, 0)
        );
        int24 lower = (tick - 1823) / 60 * 60 - 60;
        int24 upper = (tick + 1823) / 60 * 60 + 60;
        seeder.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams(lower, upper, SafeCast.toInt256(uint256(1e16)), 0),
            ""
        );
    }
}
