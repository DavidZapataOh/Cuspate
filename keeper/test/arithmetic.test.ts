import { describe, expect, test } from "vitest";
import {
	BAND,
	band,
	idleReason,
	impliedPrice,
	probability,
	sqrtPriceAtYesDollarPrice,
	sqrtPriceX96,
	worldPrice,
} from "../src/arithmetic.ts";

// The reference keeper's vectors, from the contracts' fork test of coherence: three pools opened at
// 1,100 and 1,023.4625 dollars a share and a probability of 0.6, with the token order they had there.
const YES_SQRT = 2627700878891155076788997n; // the share is the first currency
const NO_SQRT = 2476530132120974427038471330879474n; // the share is the second currency
const PROBABILITY_SQRT = 64689523806083061751132589430n; // the yes-dollar is the second currency

describe("the arithmetic, against the reference keeper's vectors", () => {
	test("each world's price, at 18 decimals, rounded as the reference rounds it", () => {
		expect(worldPrice(YES_SQRT, true)).toBe(1_099_999_999_999_999_999_988n);
		expect(worldPrice(NO_SQRT, false)).toBe(1_023_462_499_999_999_999_999n);
	});

	test("the probability", () => {
		expect(probability(PROBABILITY_SQRT, false)).toBe(600_000_000_000_000_000n);
	});

	test("the implied price, p * V_yes + (1 - p) * V_no", () => {
		const p = probability(PROBABILITY_SQRT, false);
		expect(
			impliedPrice(p, worldPrice(YES_SQRT, true), worldPrice(NO_SQRT, false)),
		).toBe(1_069_384_999_999_999_999_992n);
	});

	test("the opening prices, as the protocol's library computes them", () => {
		expect(
			sqrtPriceX96({
				price: 1100n,
				priceDecimals: 0,
				baseIsFirst: true,
				decimals0: 18,
				decimals1: 6,
			}),
		).toBe(YES_SQRT);
		expect(
			sqrtPriceX96({
				price: 10_234_625n,
				priceDecimals: 4,
				baseIsFirst: false,
				decimals0: 6,
				decimals1: 18,
			}),
		).toBe(NO_SQRT);
		expect(sqrtPriceAtYesDollarPrice(600_000_000_000_000_000n, false)).toBe(
			PROBABILITY_SQRT,
		);
	});

	test("the band around the feed's quote, its prices at 8 decimals", () => {
		expect(BAND).toBe(10n ** 16n);
		expect(band(100_000_000_000n, 101_000_000_000n)).toEqual({
			lower: 990n * 10n ** 18n,
			upper: 1_020_100_000_000_000_000_000n,
		});
	});
});

describe("the oracle policy: the keeper stays still on a closed, stale or insane feed, or a frozen market", () => {
	const open = {
		price: 106_938_500_000n,
		bid: 106_900_000_000n,
		ask: 107_000_000_000n,
		publishedAt: 1000n,
		session: 1,
	};
	const now = 1100n;
	const freezesAt = 10_000n;

	test("acts on an open, fresh, sane feed", () => {
		expect(idleReason(open, now, freezesAt)).toBeNull();
	});

	test("idles while the market is closed", () => {
		for (const session of [0, 5])
			expect(idleReason({ ...open, session }, now, freezesAt)).toBe("closed");
	});

	test("idles on a price, bid or ask that makes no sense", () => {
		expect(idleReason({ ...open, price: 0n }, now, freezesAt)).toBe("insane");
		expect(idleReason({ ...open, bid: 0n }, now, freezesAt)).toBe("insane");
		expect(idleReason({ ...open, bid: open.ask + 1n }, now, freezesAt)).toBe(
			"insane",
		);
	});

	test("idles on a round older than 1,500 seconds", () => {
		expect(idleReason(open, open.publishedAt + 1500n, freezesAt)).toBeNull();
		expect(idleReason(open, open.publishedAt + 1501n, freezesAt)).toBe("stale");
	});

	test("idles from the freeze on", () => {
		const fresh = { ...open, publishedAt: freezesAt - 10n };
		expect(idleReason(fresh, freezesAt - 1n, freezesAt)).toBeNull();
		expect(idleReason(fresh, freezesAt, freezesAt)).toBe("frozen");
	});
});
