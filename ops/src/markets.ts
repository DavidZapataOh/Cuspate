/**
 * One market's opening, as the treasury's Safe sends it in a single transaction: the hook registers the
 * market, the three pools open at their prices, both collaterals are split, the four legs are approved
 * through Permit2, and the position manager mints one position in each pool. All of it in one batch,
 * so nobody can open a registered pool at another price in between.
 */
import {
	type Address,
	encodeAbiParameters,
	encodeFunctionData,
	encodePacked,
	type Hex,
	maxUint256,
	parseAbi,
} from "viem";
import {
	amountsFor,
	conditionalSqrtPrice,
	liquidityFor,
	probabilitySqrtPrice,
	rangeAround,
} from "./pools.ts";

/** The pools' fee and spacing, as the protocol fixes them. */
export const FEE = 3000;
export const TICK_SPACING = 60;
/** How far above its computed amount a mint may go: one part in a thousand. */
const TOLERANCE = 1000n;
const MINT_POSITION = 0x02;
const SETTLE_PAIR = 0x0d;

export type PoolKey = {
	currency0: Address;
	currency1: Address;
	fee: number;
	tickSpacing: number;
	hooks: Address;
};

const ABI = parseAbi([
	"function register(bytes32 marketId, bytes32 eventId) returns (bytes32)",
	"function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24)",
	"function approve(address spender, uint256 amount) returns (bool)",
	"function splitPosition(uint256 amount)",
	"function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
]);
const PERMIT2 = parseAbi([
	"function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

export type SeedInput = {
	marketId: Hex;
	eventId: Hex;
	hook: Address;
	manager: Address;
	positionManager: Address;
	permit2: Address;
	stock: Address;
	dollar: Address;
	underlyingVault: Address;
	dollarVault: Address;
	legs: {
		underlyingYes: Address;
		underlyingNo: Address;
		dollarYes: Address;
		dollarNo: Address;
	};
	shareDecimals: number;
	dollarDecimals: number;
	/** The stock's price, eight decimals, as the feed publishes it. */
	spot: bigint;
	/** The yes-dollar's opening price. */
	chance: number;
	/** How much of the stock and of the dollar the batch splits. */
	shares: bigint;
	dollars: bigint;
	halfWidthTicks: number;
	/** The position manager's next token id, read just before the batch is built. */
	nextTokenId: bigint;
	/** Who owns the positions: the treasury. */
	recipient: Address;
	deadline: bigint;
};

/** A pool's key in the order the pool manager requires. */
export function keyOf(a: Address, b: Address, hooks: Address): PoolKey {
	const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
	return { currency0, currency1, fee: FEE, tickSpacing: TICK_SPACING, hooks };
}

type Planned = {
	key: PoolKey;
	sqrtPriceX96: bigint;
	lower: number;
	upper: number;
	liquidity: bigint;
	max0: bigint;
	max1: bigint;
};

/** A position from what is given of each currency, its maxima within what is given. */
function position(
	key: PoolKey,
	sqrtPriceX96: bigint,
	given: Record<string, bigint>,
	halfWidth: number,
): Planned {
	const { lower, upper } = rangeAround(sqrtPriceX96, halfWidth, TICK_SPACING);
	const budget = (amount: bigint) => (amount * TOLERANCE) / (TOLERANCE + 1n);
	const liquidity = liquidityFor(
		sqrtPriceX96,
		lower,
		upper,
		budget(given[key.currency0] ?? 0n),
		budget(given[key.currency1] ?? 0n),
	);
	const { amount0, amount1 } = amountsFor(
		sqrtPriceX96,
		lower,
		upper,
		liquidity,
	);
	return {
		key,
		sqrtPriceX96,
		lower,
		upper,
		liquidity,
		max0: amount0 + amount0 / TOLERANCE,
		max1: amount1 + amount1 / TOLERANCE,
	};
}

function mintCall(pool: Planned, recipient: Address, deadline: bigint): Hex {
	const keyType = {
		type: "tuple",
		components: [
			{ name: "currency0", type: "address" },
			{ name: "currency1", type: "address" },
			{ name: "fee", type: "uint24" },
			{ name: "tickSpacing", type: "int24" },
			{ name: "hooks", type: "address" },
		],
	} as const;
	const mint = encodeAbiParameters(
		[
			keyType,
			{ type: "int24" },
			{ type: "int24" },
			{ type: "uint256" },
			{ type: "uint128" },
			{ type: "uint128" },
			{ type: "address" },
			{ type: "bytes" },
		],
		[
			pool.key,
			pool.lower,
			pool.upper,
			pool.liquidity,
			pool.max0,
			pool.max1,
			recipient,
			"0x",
		],
	);
	const settle = encodeAbiParameters(
		[{ type: "address" }, { type: "address" }],
		[pool.key.currency0, pool.key.currency1],
	);
	const unlockData = encodeAbiParameters(
		[{ type: "bytes" }, { type: "bytes[]" }],
		[
			encodePacked(["uint8", "uint8"], [MINT_POSITION, SETTLE_PAIR]),
			[mint, settle],
		],
	);
	return encodeFunctionData({
		abi: ABI,
		functionName: "modifyLiquidities",
		args: [unlockData, deadline],
	});
}

/** The batch that opens and seeds one market, with what it plans for each pool. */
export function seedPlan(input: SeedInput) {
	const { legs, hook } = input;
	const yesKey = keyOf(legs.underlyingYes, legs.dollarYes, hook);
	const noKey = keyOf(legs.underlyingNo, legs.dollarNo, hook);
	const probabilityKey = keyOf(legs.dollarYes, legs.dollarNo, hook);
	const conditional = (key: PoolKey, share: Address) =>
		conditionalSqrtPrice(
			input.spot,
			key.currency0 === share,
			input.shareDecimals,
			input.dollarDecimals,
		);
	const half = input.dollars / 2n;
	const pools = [
		position(
			yesKey,
			conditional(yesKey, legs.underlyingYes),
			{ [legs.underlyingYes]: input.shares, [legs.dollarYes]: half },
			input.halfWidthTicks,
		),
		position(
			noKey,
			conditional(noKey, legs.underlyingNo),
			{ [legs.underlyingNo]: input.shares, [legs.dollarNo]: half },
			input.halfWidthTicks,
		),
		position(
			probabilityKey,
			probabilitySqrtPrice(
				input.chance,
				probabilityKey.currency0 === legs.dollarYes,
			),
			{
				[legs.dollarYes]: input.dollars - half,
				[legs.dollarNo]: input.dollars - half,
			},
			input.halfWidthTicks,
		),
	];
	const call = (to: Address, data: Hex) => ({ to, data });
	const calls = [
		call(
			hook,
			encodeFunctionData({
				abi: ABI,
				functionName: "register",
				args: [input.marketId, input.eventId],
			}),
		),
		...pools.map((pool) =>
			call(
				input.manager,
				encodeFunctionData({
					abi: ABI,
					functionName: "initialize",
					args: [pool.key, pool.sqrtPriceX96],
				}),
			),
		),
		call(
			input.stock,
			encodeFunctionData({
				abi: ABI,
				functionName: "approve",
				args: [input.underlyingVault, input.shares],
			}),
		),
		call(
			input.underlyingVault,
			encodeFunctionData({
				abi: ABI,
				functionName: "splitPosition",
				args: [input.shares],
			}),
		),
		call(
			input.dollar,
			encodeFunctionData({
				abi: ABI,
				functionName: "approve",
				args: [input.dollarVault, input.dollars],
			}),
		),
		call(
			input.dollarVault,
			encodeFunctionData({
				abi: ABI,
				functionName: "splitPosition",
				args: [input.dollars],
			}),
		),
		...[
			legs.underlyingYes,
			legs.underlyingNo,
			legs.dollarYes,
			legs.dollarNo,
		].flatMap((leg) => [
			call(
				leg,
				encodeFunctionData({
					abi: ABI,
					functionName: "approve",
					args: [input.permit2, maxUint256],
				}),
			),
			call(
				input.permit2,
				encodeFunctionData({
					abi: PERMIT2,
					functionName: "approve",
					args: [leg, input.positionManager, 2n ** 160n - 1n, 2 ** 48 - 1],
				}),
			),
		]),
		...pools.map((pool) =>
			call(
				input.positionManager,
				mintCall(pool, input.recipient, input.deadline),
			),
		),
	];
	return {
		calls,
		pools,
		tokenIds: [
			input.nextTokenId,
			input.nextTokenId + 1n,
			input.nextTokenId + 2n,
		],
	};
}
