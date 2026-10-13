// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ConditionalPools} from "../../src/ConditionalPools.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {TestCollateral} from "./PositionVault.t.sol";
import {TestStock} from "./MarketFactory.t.sol";

/// @notice Stands in for a dollar vault whose legs sit at chosen addresses, so both currency orders
///         of the probability pool are tested on purpose; the real vault creates its legs where it
///         creates them.
contract DollarLegsStub {
    /// @notice The yes leg's address.
    address public immutable YES;

    /// @notice The no leg's address.
    address public immutable NO;

    /// @notice Records the two legs.
    /// @param yes The yes leg.
    /// @param no The no leg.
    constructor(address yes, address no) {
        YES = yes;
        NO = no;
    }
}

/// @notice Calls the library externally, so its refusals can be expected.
contract ConditionalPoolsCaller {
    /// @notice The library's starting price.
    /// @param key The pool.
    /// @param base The token being priced.
    /// @param price Its price in the other token, scaled by `priceDecimals`.
    /// @param priceDecimals The price's decimals.
    /// @return The square root of the pool's price, as the pool stores it.
    function sqrtPriceX96(
        PoolKey memory key,
        IERC20Metadata base,
        uint256 price,
        uint8 priceDecimals
    ) external view returns (uint160) {
        return ConditionalPools.sqrtPriceX96(key, base, price, priceDecimals);
    }

    /// @notice The library's opening price for a yes-dollar price.
    /// @param dollarVault The vault whose legs the pool pairs.
    /// @param price The yes-dollar's price in dollars, 18-decimal.
    /// @return The square root of the pool's price, as the pool stores it.
    function sqrtPriceAtYesDollarPrice(PositionVault dollarVault, uint256 price)
        external
        view
        returns (uint160)
    {
        return ConditionalPools.sqrtPriceAtYesDollarPrice(dollarVault, price);
    }

    /// @notice The library's reading of a yes-dollar price.
    /// @param dollarVault The vault whose legs the pool pairs.
    /// @param sqrtPriceX96 The pool's sqrt price.
    /// @return The yes-dollar's price in dollars, 18-decimal.
    function yesDollarPriceAt(PositionVault dollarVault, uint160 sqrtPriceX96)
        external
        view
        returns (uint256)
    {
        return ConditionalPools.yesDollarPriceAt(dollarVault, sqrtPriceX96);
    }
}

/// @title ConditionalPoolsTest
/// @notice A market's two pools pair its legs world by world, and open at the conditional value
///         given, in raw units, whatever the currency order and the decimals. Every expected price
///         is the exact floor computed off chain in integer arithmetic, never by the code under test.
contract ConditionalPoolsTest is Test {
    using PoolIdLibrary for PoolKey;

    /// @notice Two addresses in a known order, so each currency order is tested on purpose rather
    ///         than by however deployment addresses happen to sort.
    address internal constant LOW = address(0x1000000000000000000000000000000000000000);
    address internal constant HIGH = address(0x2000000000000000000000000000000000000000);

    MarketFactory internal factory;
    PositionVault internal underlyingVault;
    PositionVault internal dollarVault;
    ConditionalPoolsCaller internal caller;

    /// @notice A market over an 18-decimal stock and a 6-decimal dollar.
    function setUp() public {
        factory = new MarketFactory();
        (underlyingVault, dollarVault) = factory.markets(
            factory.createMarket(
                IERC20(address(new TestStock())),
                IERC20(address(new TestCollateral())),
                keccak256("event"),
                address(1)
            )
        );
        caller = new ConditionalPoolsCaller();
    }

    /// @notice The yes pool pairs the two yes legs and the no pool the two no legs, each sorted,
    ///         with the fixed fee and spacing and the given hook.
    function test_keysPairTheLegsWorldByWorld() public view {
        IHooks hooks = IHooks(address(0xBEEF));
        (PoolKey memory yes, PoolKey memory no) =
            ConditionalPools.keysOf(underlyingVault, dollarVault, hooks);
        _assertPair(yes, address(underlyingVault.YES()), address(dollarVault.YES()));
        _assertPair(no, address(underlyingVault.NO()), address(dollarVault.NO()));
        assertEq(yes.fee, 3000);
        assertEq(no.fee, 3000);
        assertEq(yes.tickSpacing, 60);
        assertEq(no.tickSpacing, 60);
        assertEq(address(yes.hooks), address(hooks));
        assertEq(address(no.hooks), address(hooks));
    }

    /// @notice Two markets sharing an underlying have four distinct pools.
    function test_twoMarketsHaveFourDistinctPools() public {
        (, PositionVault otherDollar) = factory.markets(
            factory.createMarket(
                underlyingVault.COLLATERAL(),
                dollarVault.COLLATERAL(),
                keccak256("another"),
                address(1)
            )
        );
        (PoolKey memory a, PoolKey memory b) =
            ConditionalPools.keysOf(underlyingVault, dollarVault, IHooks(address(0)));
        (PoolKey memory c, PoolKey memory d) =
            ConditionalPools.keysOf(underlyingVault, otherDollar, IHooks(address(0)));
        bytes32[4] memory ids = [
            PoolId.unwrap(a.toId()),
            PoolId.unwrap(b.toId()),
            PoolId.unwrap(c.toId()),
            PoolId.unwrap(d.toId())
        ];
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 j = i + 1; j < 4; j++) {
                assertNotEq(ids[i], ids[j]);
            }
        }
    }

    /// @notice An 18-decimal share at 1,040 of a 6-decimal dollar, as the first currency.
    function test_aShareFirstOpensAtItsValue() public {
        PoolKey memory key = _pair(18, 6);
        uint160 sqrtPrice = caller.sqrtPriceX96(key, IERC20Metadata(LOW), 1040, 0);
        assertEq(sqrtPrice, 2555031468456337426639666);
        assertEq(TickMath.getTickAtSqrtPrice(sqrtPrice), -206851);
        assertEq(caller.sqrtPriceX96(key, IERC20Metadata(LOW), 960, 0), 2454794831746884205029622);
    }

    /// @notice The same share and dollar with the share as the second currency: the pool's price is
    ///         inverted, not merely re-read.
    function test_aShareSecondOpensAtItsValue() public {
        PoolKey memory key = _pair(6, 18);
        uint160 sqrtPrice = caller.sqrtPriceX96(key, IERC20Metadata(HIGH), 1040, 0);
        assertEq(sqrtPrice, 2456761027361862910230448246114972);
        assertEq(TickMath.getTickAtSqrtPrice(sqrtPrice), 206850);
        assertEq(
            caller.sqrtPriceX96(key, IERC20Metadata(HIGH), 960, 0),
            2557077949736337713572523183064707
        );
    }

    /// @notice Equal decimals, with a price given to one decimal place.
    function test_equalDecimalsAndAFractionalPrice() public {
        PoolKey memory key = _pair(18, 18);
        assertEq(
            caller.sqrtPriceX96(key, IERC20Metadata(LOW), 25, 1), 125270724187523965593206900784
        );
    }

    /// @notice A six-decimal base priced in an eighteen-decimal quote, in both currency orders.
    function test_aSixDecimalBaseInBothOrders() public {
        PoolKey memory first = _pair(6, 18);
        assertEq(
            caller.sqrtPriceX96(first, IERC20Metadata(LOW), 3, 0),
            137227202865029797602485611888471561
        );
        PoolKey memory second = _pair(18, 6);
        assertEq(caller.sqrtPriceX96(second, IERC20Metadata(HIGH), 3, 0), 45742400955009932534161);
    }

    /// @notice A raw ratio of 1e20, above 2**64 yet inside the pool's range, is computed rather
    ///         than overflowing: exactly in one order, and its inverse in the other.
    function test_aRatioAboveTwoToTheSixtyFour() public {
        PoolKey memory first = _pair(6, 18);
        assertEq(
            caller.sqrtPriceX96(first, IERC20Metadata(LOW), 1e8, 0),
            792281625142643375935439503360000000000
        );
        PoolKey memory second = _pair(18, 6);
        assertEq(caller.sqrtPriceX96(second, IERC20Metadata(HIGH), 1e8, 0), 7922816251426433759);
    }

    /// @notice A price whose square root lies above the pool's range is refused, not clamped.
    function test_RevertWhen_thePriceIsAboveTheRange() public {
        PoolKey memory key = _pair(18, 18);
        vm.expectRevert(
            abi.encodeWithSelector(ConditionalPools.PriceOutOfRange.selector, type(uint128).max, 0)
        );
        caller.sqrtPriceX96(key, IERC20Metadata(LOW), type(uint128).max, 0);
        vm.expectRevert(
            abi.encodeWithSelector(ConditionalPools.PriceOutOfRange.selector, type(uint192).max, 0)
        );
        caller.sqrtPriceX96(key, IERC20Metadata(LOW), type(uint192).max, 0);
    }

    /// @notice A price whose square root lies below the pool's range is refused, not clamped.
    function test_RevertWhen_thePriceIsBelowTheRange() public {
        PoolKey memory key = _pair(18, 6);
        vm.expectRevert(abi.encodeWithSelector(ConditionalPools.PriceOutOfRange.selector, 1, 38));
        caller.sqrtPriceX96(key, IERC20Metadata(LOW), 1, 38);
    }

    /// @notice A price too large to scale, or scaled by more decimals than a word holds, is refused
    ///         with the same error rather than an arithmetic panic.
    function test_RevertWhen_thePriceCannotBeScaled() public {
        PoolKey memory key = _pair(18, 18);
        vm.expectRevert(
            abi.encodeWithSelector(ConditionalPools.PriceOutOfRange.selector, type(uint256).max, 0)
        );
        caller.sqrtPriceX96(key, IERC20Metadata(LOW), type(uint256).max, 0);
        vm.expectRevert(abi.encodeWithSelector(ConditionalPools.PriceOutOfRange.selector, 1, 42));
        caller.sqrtPriceX96(key, IERC20Metadata(LOW), 1, 42);
    }

    /// @notice A zero price is refused, as either currency: no pool opens at nothing.
    function test_RevertWhen_thePriceIsZero() public {
        PoolKey memory key = _pair(18, 18);
        vm.expectRevert(abi.encodeWithSelector(ConditionalPools.PriceOutOfRange.selector, 0, 0));
        caller.sqrtPriceX96(key, IERC20Metadata(LOW), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(ConditionalPools.PriceOutOfRange.selector, 0, 0));
        caller.sqrtPriceX96(key, IERC20Metadata(HIGH), 0, 0);
    }

    /// @notice A base that is not one of the pool's currencies is refused.
    function test_RevertWhen_theBaseIsNotInThePool() public {
        PoolKey memory key = _pair(18, 6);
        IERC20Metadata stranger = IERC20Metadata(address(new TestStock()));
        vm.expectRevert(abi.encodeWithSelector(ConditionalPools.NotInPool.selector, stranger));
        caller.sqrtPriceX96(key, stranger, 1040, 0);
    }

    /// @notice The probability pool pairs the dollar's two legs, sorted, at the same fee, spacing
    ///         and hook, and is neither of the conditional pools.
    function test_theProbabilityKeyPairsTheDollarLegs() public view {
        IHooks hooks = IHooks(address(0xBEEF));
        PoolKey memory key = ConditionalPools.probabilityKeyOf(dollarVault, hooks);
        _assertPair(key, address(dollarVault.YES()), address(dollarVault.NO()));
        assertEq(key.fee, 3000);
        assertEq(key.tickSpacing, 60);
        assertEq(address(key.hooks), address(hooks));
        (PoolKey memory yes, PoolKey memory no) =
            ConditionalPools.keysOf(underlyingVault, dollarVault, hooks);
        assertNotEq(PoolId.unwrap(key.toId()), PoolId.unwrap(yes.toId()));
        assertNotEq(PoolId.unwrap(key.toId()), PoolId.unwrap(no.toId()));
    }

    /// @notice With the yes-dollar as the first currency, the pool stores p / (1 - p) no-dollars per
    ///         yes-dollar: the exact floors computed off chain, from one wei to one wei short of one.
    function test_aYesDollarFirstOpensAtItsPrice() public {
        PositionVault vault = PositionVault(address(new DollarLegsStub(LOW, HIGH)));
        uint160 sqrtPrice = caller.sqrtPriceAtYesDollarPrice(vault, 0.6e18);
        assertEq(sqrtPrice, 97034285709124592626698884146);
        assertEq(TickMath.getTickAtSqrtPrice(sqrtPrice), 4054);
        assertEq(caller.sqrtPriceAtYesDollarPrice(vault, 0.5e18), 1 << 96);
        assertEq(caller.sqrtPriceAtYesDollarPrice(vault, 0.01e18), 7962729936033803262996961366);
        assertEq(caller.sqrtPriceAtYesDollarPrice(vault, 0.99e18), 788310263667346523036699175314);
        assertEq(caller.sqrtPriceAtYesDollarPrice(vault, 1), 79228162514264337633);
        assertEq(
            caller.sqrtPriceAtYesDollarPrice(vault, 1e18 - 1),
            79228162514264337553929869078867831193
        );
    }

    /// @notice With the yes-dollar as the second currency the stored price is inverted.
    function test_aYesDollarSecondOpensAtItsPrice() public {
        PositionVault vault = PositionVault(address(new DollarLegsStub(HIGH, LOW)));
        uint160 sqrtPrice = caller.sqrtPriceAtYesDollarPrice(vault, 0.6e18);
        assertEq(sqrtPrice, 64689523806083061751132589430);
        assertEq(TickMath.getTickAtSqrtPrice(sqrtPrice), -4055);
        assertEq(caller.sqrtPriceAtYesDollarPrice(vault, 0.5e18), 1 << 96);
        assertEq(caller.sqrtPriceAtYesDollarPrice(vault, 0.01e18), 788310263667346523036699175314);
        assertEq(caller.sqrtPriceAtYesDollarPrice(vault, 0.99e18), 7962729936033803262996961366);
        assertEq(caller.sqrtPriceAtYesDollarPrice(vault, 1), 79228162514264337553929869078867831193);
        assertEq(caller.sqrtPriceAtYesDollarPrice(vault, 1e18 - 1), 79228162514264337633);
    }

    /// @notice Reading an opening back gives the price or one wei less, never more, in both orders.
    function test_aReadingNeverOverstates() public {
        PositionVault first = PositionVault(address(new DollarLegsStub(LOW, HIGH)));
        PositionVault second = PositionVault(address(new DollarLegsStub(HIGH, LOW)));
        assertEq(caller.yesDollarPriceAt(first, 97034285709124592626698884146), 0.6e18 - 1);
        assertEq(caller.yesDollarPriceAt(second, 64689523806083061751132589430), 0.6e18);
        assertEq(caller.yesDollarPriceAt(first, 1 << 96), 0.5e18);
        assertEq(caller.yesDollarPriceAt(second, 1 << 96), 0.5e18);
        assertEq(caller.yesDollarPriceAt(first, 788310263667346523036699175314), 0.99e18 - 1);
        assertEq(caller.yesDollarPriceAt(second, 7962729936033803262996961366), 0.99e18 - 1);
        assertEq(caller.yesDollarPriceAt(first, 79228162514264337633), 0);
        assertEq(caller.yesDollarPriceAt(second, 79228162514264337553929869078867831193), 1);
    }

    /// @notice At the pool's extreme prices the reading is 0 or one wei short of one: never one, so
    ///         a consumer must still guard a division by the price or by one minus it.
    function test_theReadingAtThePoolsBounds() public {
        PositionVault first = PositionVault(address(new DollarLegsStub(LOW, HIGH)));
        PositionVault second = PositionVault(address(new DollarLegsStub(HIGH, LOW)));
        assertEq(caller.yesDollarPriceAt(first, TickMath.MIN_SQRT_PRICE), 0);
        assertEq(caller.yesDollarPriceAt(second, TickMath.MIN_SQRT_PRICE), 1e18 - 1);
        assertEq(caller.yesDollarPriceAt(first, TickMath.MAX_SQRT_PRICE - 1), 1e18 - 1);
        assertEq(caller.yesDollarPriceAt(second, TickMath.MAX_SQRT_PRICE - 1), 0);
    }

    /// @notice A yes-dollar price of nothing, of a whole dollar, or above it is refused with the
    ///         typed error, before any subtraction could underflow.
    function test_RevertWhen_theYesDollarPriceIsNotBetweenZeroAndOne() public {
        PositionVault vault = PositionVault(address(new DollarLegsStub(LOW, HIGH)));
        vm.expectRevert(
            abi.encodeWithSelector(ConditionalPools.YesDollarPriceOutOfRange.selector, 0)
        );
        caller.sqrtPriceAtYesDollarPrice(vault, 0);
        vm.expectRevert(
            abi.encodeWithSelector(ConditionalPools.YesDollarPriceOutOfRange.selector, 1e18)
        );
        caller.sqrtPriceAtYesDollarPrice(vault, 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(ConditionalPools.YesDollarPriceOutOfRange.selector, 1e18 + 1)
        );
        caller.sqrtPriceAtYesDollarPrice(vault, 1e18 + 1);
    }

    /// @notice The spot reading comes from the pool manager, at the pool the vault and hook name:
    ///         opened at 0.6, it reads 0.6 or one wei less, whichever order the real legs sorted in.
    function test_theSpotReadingComesFromThePoolManager() public {
        IPoolManager manager = new PoolManager(address(this));
        PoolKey memory key = ConditionalPools.probabilityKeyOf(dollarVault, IHooks(address(0)));
        manager.initialize(key, ConditionalPools.sqrtPriceAtYesDollarPrice(dollarVault, 0.6e18));
        bool yesFirst = Currency.unwrap(key.currency0) == address(dollarVault.YES());
        assertEq(
            ConditionalPools.yesDollarPriceOf(manager, dollarVault, IHooks(address(0))),
            yesFirst ? 0.6e18 - 1 : 0.6e18
        );
    }

    /// @notice A hookless pool of two tokens at known addresses, the lower with `lowDecimals`.
    /// @param lowDecimals The first currency's decimals.
    /// @param highDecimals The second currency's decimals.
    /// @return key The pool.
    function _pair(uint8 lowDecimals, uint8 highDecimals) internal returns (PoolKey memory key) {
        deployCodeTo(
            "PositionToken.sol:PositionToken",
            abi.encode("low", "LOW", lowDecimals, address(this)),
            LOW
        );
        deployCodeTo(
            "PositionToken.sol:PositionToken",
            abi.encode("high", "HIGH", highDecimals, address(this)),
            HIGH
        );
        key = PoolKey(Currency.wrap(LOW), Currency.wrap(HIGH), 3000, 60, IHooks(address(0)));
    }

    /// @notice A key holds exactly two tokens, sorted.
    /// @param key The key.
    /// @param a One token.
    /// @param b The other.
    function _assertPair(PoolKey memory key, address a, address b) internal pure {
        (address low, address high) = a < b ? (a, b) : (b, a);
        assertEq(Currency.unwrap(key.currency0), low);
        assertEq(Currency.unwrap(key.currency1), high);
    }
}
