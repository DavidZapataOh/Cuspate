import { describe, expect, test } from "vitest";
import {
	amountsFor,
	conditionalSqrtPrice,
	liquidityFor,
	MAX_TICK,
	MIN_TICK,
	multiSendData,
	probabilitySqrtPrice,
	rangeAround,
	sqrtPriceAtTick,
	tickAtSqrtPrice,
} from "../../src/pools.ts";

const Q96 = 2n ** 96n;

describe("the pool manager's tick arithmetic", () => {
	test("matches its published values at the ends and the middle", () => {
		expect(sqrtPriceAtTick(0)).toBe(Q96);
		expect(sqrtPriceAtTick(1)).toBe(79232123823359799118286999568n);
		expect(sqrtPriceAtTick(MIN_TICK)).toBe(4295128739n);
		expect(sqrtPriceAtTick(MAX_TICK)).toBe(
			1461446703485210103287273052203988822378723970342n,
		);
	});

	test("finds the tick at a price as the greatest tick at or below it", () => {
		for (const tick of [-200000, -1823, -1, 0, 1, 60, 207000]) {
			expect(tickAtSqrtPrice(sqrtPriceAtTick(tick))).toBe(tick);
			expect(tickAtSqrtPrice(sqrtPriceAtTick(tick) + 1n)).toBe(tick);
		}
	});

	test("a range is a fixed width either side, on the spacing, the upper one spacing up", () => {
		const { lower, upper } = rangeAround(sqrtPriceAtTick(1000), 1823, 60);
		expect(Math.abs(lower % 60)).toBe(0);
		expect(Math.abs(upper % 60)).toBe(0);
		expect(lower).toBe(Math.floor((1000 - 1823) / 60) * 60);
		expect(upper).toBe(Math.floor((1000 + 1823) / 60) * 60 + 60);
	});
});

describe("opening prices", () => {
	test("a conditional pool opens at the stock's price in dollars, whichever currency sorts first", () => {
		// 200 dollars a share; shares with 18 decimals, dollars with 6.
		const first = conditionalSqrtPrice(20_000_000_000n, true, 18, 6);
		const second = conditionalSqrtPrice(20_000_000_000n, false, 18, 6);
		// token1 per token0: 200e6 / 1e18 raw, and its inverse.
		const ratio = (s: bigint) => Number(s * s) / Number(Q96 * Q96);
		expect(ratio(first)).toBeCloseTo(200e6 / 1e18, 22);
		expect(ratio(second)).toBeCloseTo(1e18 / 200e6, 0);
	});

	test("the probability pool opens with the yes-dollar at the chance", () => {
		const ratio = (s: bigint) => Number(s * s) / Number(Q96 * Q96);
		expect(ratio(probabilitySqrtPrice(0.75, true))).toBeCloseTo(3, 9);
		expect(ratio(probabilitySqrtPrice(0.75, false))).toBeCloseTo(1 / 3, 9);
		expect(() => probabilitySqrtPrice(0, true)).toThrow();
		expect(() => probabilitySqrtPrice(1, true)).toThrow();
	});
});

describe("liquidity from what is deposited", () => {
	test("never needs more of either currency than it was given", () => {
		const price = sqrtPriceAtTick(-207000);
		const { lower, upper } = rangeAround(price, 1823, 60);
		const liquidity = liquidityFor(
			price,
			lower,
			upper,
			50n * 10n ** 18n,
			10_000n * 10n ** 6n,
		);
		const { amount0, amount1 } = amountsFor(price, lower, upper, liquidity);
		expect(liquidity).toBeGreaterThan(0n);
		expect(amount0).toBeLessThanOrEqual(50n * 10n ** 18n);
		expect(amount1).toBeLessThanOrEqual(10_000n * 10n ** 6n);
		// It uses one of the two to the full within rounding.
		const used0 = Number(amount0) / 50e18;
		const used1 = Number(amount1) / 10_000e6;
		expect(Math.max(used0, used1)).toBeGreaterThan(0.999);
	});
});

describe("a Safe's batch", () => {
	test("is MultiSendCallOnly's packed encoding: a call, its target, no value, the data's length, the data", () => {
		const data = multiSendData([
			{ to: "0x00000000000000000000000000000000000000aa", data: "0x1234" },
		]);
		// multiSend(bytes) selector, offset, length, then one packed transaction.
		expect(data.slice(0, 10)).toBe("0x8d80ff0a");
		const packed =
			"00" +
			"00000000000000000000000000000000000000aa" +
			"0".repeat(64) +
			"0".repeat(63) +
			"2" +
			"1234";
		expect(data).toContain(packed);
	});
});
