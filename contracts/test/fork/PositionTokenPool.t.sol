// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {AddressBook} from "../../script/AddressBook.sol";
import {PositionToken} from "../../src/PositionToken.sol";

/// @title PositionTokenPoolTest
/// @notice Two legs used as the currencies of a pool in the venue as it is deployed on the
///         production chain, at a pinned block: a leg that is a correct token in isolation can
///         still fail where settlement credits only what arrives, and this is where that shows.
contract PositionTokenPoolTest is Test {
    /// @notice The chain whose state this selection reads.
    uint256 internal constant PRODUCTION_CHAIN = 143;

    /// @notice A pool with no hook, at a common fee tier and its tick spacing.
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    IPoolManager internal manager;
    PoolModifyLiquidityTest internal liquidityRouter;
    PoolSwapTest internal swapRouter;
    PoolKey internal key;

    /// @notice Opens on a fork at the pinned block, proves it is there, and initialises a pool of
    ///         two legs at a price of one.
    function setUp() public {
        vm.chainId(PRODUCTION_CHAIN);
        uint256 pinned = AddressBook.pinnedBlock();
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC_URL", string("monad_archive")), pinned);

        manager = IPoolManager(AddressBook.thirdParty("poolManager", 0));
        assertEq(block.chainid, PRODUCTION_CHAIN, "not on a fork of the production chain");
        assertEq(block.number, pinned, "not at the pinned block");
        assertGt(
            address(manager).code.length,
            0,
            "no code at the recorded pool manager at the pinned block: if the endpoint no longer "
            "serves this block, re-pin it; the assertion itself is not what failed"
        );

        PositionToken a = new PositionToken("outcome true", "LEG1", 18, address(this));
        PositionToken b = new PositionToken("outcome false", "LEG0", 18, address(this));
        (PositionToken low, PositionToken high) = address(a) < address(b) ? (a, b) : (b, a);
        key = PoolKey({
            currency0: Currency.wrap(address(low)),
            currency1: Currency.wrap(address(high)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });

        liquidityRouter = new PoolModifyLiquidityTest(manager);
        swapRouter = new PoolSwapTest(manager);
        for (uint256 index = 0; index < 2; index++) {
            PositionToken leg = index == 0 ? low : high;
            leg.mint(address(this), 1_000e18);
            leg.approve(address(liquidityRouter), type(uint256).max);
            leg.approve(address(swapRouter), type(uint256).max);
        }

        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
        liquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: -TICK_SPACING * 10,
                tickUpper: TICK_SPACING * 10,
                liquidityDelta: 100e18,
                salt: bytes32(0)
            }),
            ""
        );
    }

    /// @notice A swap each way moves both legs by exactly what the pool reports.
    function testFork_legsSwapBothWaysInTheDeployedPool() public {
        _swapAndCheck(true);
        _swapAndCheck(false);
    }

    /// @notice Swaps a fixed input in one direction and checks both balances against the delta.
    /// @param zeroForOne Whether the first currency is paid in.
    function _swapAndCheck(bool zeroForOne) private {
        PositionToken zero = PositionToken(Currency.unwrap(key.currency0));
        PositionToken one = PositionToken(Currency.unwrap(key.currency1));
        uint256 zeroBefore = zero.balanceOf(address(this));
        uint256 oneBefore = one.balanceOf(address(this));

        BalanceDelta delta = swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -1e18,
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        assertEq(
            int256(zero.balanceOf(address(this))) - int256(zeroBefore),
            int256(delta.amount0()),
            "the first leg did not move by the reported delta"
        );
        assertEq(
            int256(one.balanceOf(address(this))) - int256(oneBefore),
            int256(delta.amount1()),
            "the second leg did not move by the reported delta"
        );
        assertTrue(delta.amount0() != 0 && delta.amount1() != 0, "the swap moved nothing");
    }
}
