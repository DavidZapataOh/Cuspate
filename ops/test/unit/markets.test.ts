import { type Address, decodeFunctionData, parseAbi } from "viem";
import { describe, expect, test } from "vitest";
import { type SeedInput, seedPlan } from "../../src/markets.ts";
import { sqrtPriceAtTick, tickAtSqrtPrice } from "../../src/pools.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

const input: SeedInput = {
	marketId: `0x${"11".repeat(32)}`,
	eventId: `0x${"22".repeat(32)}`,
	hook: a(0x2080),
	manager: a(1),
	positionManager: a(2),
	permit2: a(3),
	stock: a(4),
	dollar: a(5),
	underlyingVault: a(6),
	dollarVault: a(7),
	legs: {
		underlyingYes: a(0x31),
		underlyingNo: a(0x30),
		dollarYes: a(0x40),
		dollarNo: a(0x41),
	},
	shareDecimals: 18,
	dollarDecimals: 6,
	spot: 43_500_000_000n, // 435 dollars, eight decimals
	chance: 0.5,
	shares: 22n * 10n ** 18n,
	dollars: 20_000n * 10n ** 6n,
	halfWidthTicks: 1823,
	nextTokenId: 7n,
	recipient: a(0x99),
	deadline: 2_000_000_000n,
};

const SELECTORS = parseAbi([
	"function register(bytes32 marketId, bytes32 eventId)",
	"function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96)",
	"function approve(address, uint256)",
	"function splitPosition(uint256 amount)",
	"function approve(address token, address spender, uint160 amount, uint48 expiration)",
	"function modifyLiquidities(bytes unlockData, uint256 deadline)",
]);

describe("a market's seeding batch", () => {
	const plan = seedPlan(input);
	const names = plan.calls.map(
		(call) =>
			decodeFunctionData({ abi: SELECTORS, data: call.data }).functionName,
	);

	test("registers, opens the three pools, splits both collaterals, approves the four legs, then mints three positions", () => {
		expect(names).toEqual([
			"register",
			"initialize",
			"initialize",
			"initialize",
			"approve",
			"splitPosition",
			"approve",
			"splitPosition",
			...Array(8).fill("approve"),
			"modifyLiquidities",
			"modifyLiquidities",
			"modifyLiquidities",
		]);
		expect(plan.calls[0]?.to).toBe(input.hook);
		expect(plan.calls.slice(1, 4).every((c) => c.to === input.manager)).toBe(
			true,
		);
		expect(
			plan.calls.slice(-3).every((c) => c.to === input.positionManager),
		).toBe(true);
	});

	test("the three positions are the next three token ids and pay to the recipient", () => {
		expect(plan.tokenIds).toEqual([7n, 8n, 9n]);
	});

	test("each pool opens where its range is centred, and the probability pool at the chance", () => {
		for (const pool of plan.pools) {
			const tick = tickAtSqrtPrice(pool.sqrtPriceX96);
			expect(pool.lower).toBeLessThan(tick);
			expect(pool.upper).toBeGreaterThan(tick);
		}
		const probability = plan.pools[2];
		if (!probability) throw new Error("no probability pool");
		const ratio = Number(probability.sqrtPriceX96 ** 2n) / 2 ** 192;
		// Yes-dollar 0x40 sorts before no-dollar 0x41, so the price is no per yes: p / (1 - p).
		expect(ratio).toBeCloseTo(1, 6);
	});

	test("never spends more of a leg than the split makes", () => {
		const spent = new Map<string, bigint>();
		for (const pool of plan.pools) {
			for (const [token, amount] of [
				[pool.key.currency0, pool.max0],
				[pool.key.currency1, pool.max1],
			] as const)
				spent.set(token, (spent.get(token) ?? 0n) + amount);
		}
		expect(spent.get(input.legs.underlyingYes)).toBeLessThanOrEqual(
			input.shares,
		);
		expect(spent.get(input.legs.underlyingNo)).toBeLessThanOrEqual(
			input.shares,
		);
		expect(spent.get(input.legs.dollarYes)).toBeLessThanOrEqual(input.dollars);
		expect(spent.get(input.legs.dollarNo)).toBeLessThanOrEqual(input.dollars);
		for (const pool of plan.pools) expect(pool.liquidity).toBeGreaterThan(0n);
	});

	test("refuses a chance at either extreme", () => {
		expect(() => seedPlan({ ...input, chance: 1 })).toThrow();
		expect(sqrtPriceAtTick(0)).toBe(2n ** 96n);
	});
});
