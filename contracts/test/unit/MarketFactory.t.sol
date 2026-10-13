// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketFactory} from "../../src/MarketFactory.sol";
import {PositionVault} from "../../src/PositionVault.sol";
import {TestCollateral} from "./PositionVault.t.sol";

/// @title TestStock
/// @notice An eighteen-decimal collateral standing in for a tokenized share, for tests only.
contract TestStock is ERC20 {
    /// @notice Creates the token.
    constructor() ERC20("test stock", "TSTK") {}

    /// @notice Creates tokens for anyone.
    /// @param to The holder credited.
    /// @param amount How much.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title BytesSymbolToken
/// @notice A collateral that reports its symbol as a fixed thirty-two bytes rather than a string,
///         as some early tokens do. For tests only.
contract BytesSymbolToken {
    /// @notice Eighteen decimals.
    /// @return The number of decimals.
    function decimals() external pure returns (uint8) {
        return 18;
    }

    /// @notice A symbol in the old fixed-width form.
    /// @return The symbol.
    function symbol() external pure returns (bytes32) {
        return "OLD";
    }
}

/// @title NoSymbolToken
/// @notice A collateral that reports no symbol at all. For tests only.
contract NoSymbolToken {
    /// @notice Eighteen decimals.
    /// @return The number of decimals.
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

/// @title MarketFactoryTest
/// @notice Creating a market: one event over an underlying and a dollar, as two vaults and four legs.
contract MarketFactoryTest is Test {
    bytes32 internal constant EVENT = keccak256("an event");

    address internal resolver = makeAddr("resolver");

    MarketFactory internal factory;
    IERC20 internal underlying;
    IERC20 internal dollar;

    /// @notice A factory and two test collaterals.
    function setUp() public {
        factory = new MarketFactory();
        underlying = IERC20(address(new TestStock()));
        dollar = IERC20(address(new TestCollateral()));
    }

    /// @notice Each collateral gets a vault holding it, and each vault mints its own two legs.
    function test_createMarketDeploysAVaultForEachCollateral() public {
        bytes32 id = factory.createMarket(
            underlying, dollar, EVENT, resolver, type(uint256).max, type(uint256).max
        );
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(id);
        assertEq(address(underlyingVault.COLLATERAL()), address(underlying));
        assertEq(address(dollarVault.COLLATERAL()), address(dollar));
        assertEq(underlyingVault.YES().MINTER(), address(underlyingVault));
        assertEq(dollarVault.NO().MINTER(), address(dollarVault));
    }

    /// @notice The registry holds both vaults under the market's id.
    function test_createMarketRecordsTheMarket() public {
        bytes32 id = factory.createMarket(
            underlying, dollar, EVENT, resolver, type(uint256).max, type(uint256).max
        );
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(id);
        assertTrue(address(underlyingVault) != address(0));
        assertTrue(address(dollarVault) != address(0));
        assertTrue(address(underlyingVault) != address(dollarVault));
    }

    /// @notice A market is announced with everything that identifies it and everything it created,
    ///         read back from the log itself.
    function test_createMarketEmitsMarketCreated() public {
        vm.recordLogs();
        bytes32 id = factory.createMarket(
            underlying, dollar, EVENT, resolver, type(uint256).max, type(uint256).max
        );
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(id);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory created;
        uint256 found;
        for (uint256 index = 0; index < logs.length; index++) {
            if (logs[index].topics[0] == MarketFactory.MarketCreated.selector) {
                created = logs[index];
                found++;
            }
        }
        assertEq(found, 1, "exactly one market announced");
        assertEq(created.emitter, address(factory));
        assertEq(created.topics[1], id);
        assertEq(created.topics[2], bytes32(uint256(uint160(address(underlying)))));
        assertEq(created.topics[3], bytes32(uint256(uint160(address(dollar)))));
        (
            bytes32 eventId,
            address loggedResolver,
            address loggedUnderlyingVault,
            address loggedDollarVault
        ) = abi.decode(created.data, (bytes32, address, address, address));
        assertEq(eventId, EVENT);
        assertEq(loggedResolver, resolver);
        assertEq(loggedUnderlyingVault, address(underlyingVault));
        assertEq(loggedDollarVault, address(dollarVault));
    }

    /// @notice A market's id is the hash of its collaterals, its condition (the hash of its resolver
    ///         and its event) and its two caps, in that order: swapping the caps is another market.
    function test_marketIdIsAHashOfItsInputs() public view {
        assertEq(
            factory.marketId(underlying, dollar, factory.condition(resolver, EVENT), 1, 2),
            keccak256(abi.encode(underlying, dollar, keccak256(abi.encode(resolver, EVENT)), 1, 2))
        );
        assertNotEq(
            factory.marketId(underlying, dollar, factory.condition(resolver, EVENT), 1, 2),
            factory.marketId(underlying, dollar, factory.condition(resolver, EVENT), 2, 1)
        );
    }

    /// @notice Leg names are derived from the collateral, the outcome and the start of the id.
    function test_legNamesAreDerivedFromTheCollateralAndTheMarket() public {
        bytes32 id = factory.createMarket(
            underlying, dollar, EVENT, resolver, type(uint256).max, type(uint256).max
        );
        (PositionVault underlyingVault, PositionVault dollarVault) = factory.markets(id);
        string memory prefix = vm.toString(abi.encodePacked(bytes4(id)));
        assertEq(underlyingVault.YES().symbol(), "TSTK-YES");
        assertEq(underlyingVault.NO().symbol(), "TSTK-NO");
        assertEq(dollarVault.YES().symbol(), "TUSD-YES");
        assertEq(underlyingVault.YES().name(), string.concat("TSTK YES ", prefix));
        assertEq(dollarVault.NO().name(), string.concat("TUSD NO ", prefix));
    }

    /// @notice A second market under the same id is refused, naming the market.
    function test_RevertWhen_marketAlreadyExists() public {
        bytes32 id = factory.createMarket(
            underlying, dollar, EVENT, resolver, type(uint256).max, type(uint256).max
        );
        vm.expectRevert(abi.encodeWithSelector(MarketFactory.MarketExists.selector, id));
        factory.createMarket(
            underlying, dollar, EVENT, resolver, type(uint256).max, type(uint256).max
        );
    }

    /// @notice A market whose two collaterals are one token is refused.
    function test_RevertWhen_bothCollateralsAreTheSameToken() public {
        vm.expectRevert(abi.encodeWithSelector(MarketFactory.SameCollateral.selector, dollar));
        factory.createMarket(dollar, dollar, EVENT, resolver, type(uint256).max, type(uint256).max);
    }

    /// @notice A collateral whose symbol is not a string is refused by name, not by a bare revert.
    function test_RevertWhen_collateralSymbolIsNotAString() public {
        IERC20 odd = IERC20(address(new BytesSymbolToken()));
        vm.expectRevert(abi.encodeWithSelector(PositionVault.UnreadableMetadata.selector, odd));
        factory.createMarket(odd, dollar, EVENT, resolver, type(uint256).max, type(uint256).max);
    }

    /// @notice A collateral with no symbol at all is refused the same way.
    function test_RevertWhen_collateralHasNoSymbol() public {
        IERC20 odd = IERC20(address(new NoSymbolToken()));
        vm.expectRevert(abi.encodeWithSelector(PositionVault.UnreadableMetadata.selector, odd));
        factory.createMarket(odd, dollar, EVENT, resolver, type(uint256).max, type(uint256).max);
    }
}
