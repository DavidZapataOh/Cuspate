import assert from "node:assert/strict";
import { test } from "node:test";
import record from "../../../contracts/deployments/10143.json" with {
	type: "json",
};
import manifest from "../../../ops/events/10143.json" with { type: "json" };
import {
	historyOf,
	listedOf,
	priceIdOf,
	resolutionFromChain,
	resolutionOf,
} from "../../src/data/chain.ts";
import {
	centsOf,
	chanceOf,
	feeBpsOf,
	ONE,
	pans,
	worldPriceCents,
	yesDollarPrice,
} from "../../src/data/derive.ts";

const Q96 = 1n << 96n;
const HOOK = "0x1E6e38d5af4B5aD1f3C668411bD17C3F8D06a080";

test("a probability pool at par prices the yes-dollar at half a dollar, in either currency order", () => {
	assert.equal(yesDollarPrice(Q96, true), ONE / 2n);
	assert.equal(yesDollarPrice(Q96, false), ONE / 2n);
	assert.equal(chanceOf(ONE / 2n), 0.5);
});

test("the yes-dollar's price rises with the pool's price when it is the first currency, and falls when it is the second", () => {
	const up = Q96 * 2n;
	assert.ok(yesDollarPrice(up, true) > ONE / 2n);
	assert.ok(yesDollarPrice(up, false) < ONE / 2n);
	// A price of 3 no-dollars per yes-dollar is a chance of three in four.
	const three = 137227202865029797602485611888n; // floor(sqrt(3) * 2^96)
	assert.ok(Math.abs(chanceOf(yesDollarPrice(three, true)) - 0.75) < 1e-9);
	assert.ok(Math.abs(chanceOf(yesDollarPrice(three, false)) - 0.25) < 1e-9);
});

test("the reading never overstates: it rounds down in both orders", () => {
	for (const sqrt of [Q96 + 1n, Q96 * 3n + 7n, Q96 / 5n + 11n]) {
		for (const yesFirst of [true, false]) {
			const p = yesDollarPrice(sqrt, yesFirst);
			assert.ok(p >= 0n && p < ONE);
		}
	}
});

test("a world's share price comes back from the price its pool opened at, in either currency order", () => {
	// The record's META yes pool opened at the feed's $764.12, the share first (18 decimals), the
	// yes-dollar second (6 decimals).
	const meta = worldPriceCents(2190081956923911673104664n, true, 18, 6);
	assert.ok(meta >= 76_410n && meta <= 76_414n, `${meta}`);
	// The same price with the currencies swapped is the inverse pool price.
	const inverse = (Q96 * Q96) / 2190081956923911673104664n;
	const swapped = worldPriceCents(inverse, false, 18, 6);
	assert.ok(swapped >= 76_410n && swapped <= 76_414n, `${swapped}`);
});

test("the two pans weigh each world's price by its dollar's value and add up to the implied price", () => {
	const { beat, dont, implied } = pans(38_206n, 38_206n, ONE / 2n);
	assert.equal(beat, 19_103n);
	assert.equal(dont, 19_103n);
	assert.equal(implied, 38_206n);
	const tilted = pans(10_000n, 9_000n, (ONE * 3n) / 4n);
	assert.equal(tilted.beat, 7_500n);
	assert.equal(tilted.dont, 2_250n);
});

test("amounts in a token's units become cents, rounded down", () => {
	assert.equal(centsOf(20_000_000_000n, 6), 2_000_000n);
	assert.equal(centsOf(37_518_500_000n, 8), 37_518n);
	assert.equal(centsOf(5n, 0), 500n);
	assert.equal(feeBpsOf(3000), 30n);
});

test("the committed record's markets are read with the pools each trades in", () => {
	const listed = listedOf(record as never, HOOK);
	assert.equal(listed.length, 8);
	assert.deepEqual([...new Set(listed.map((m) => m.eventKey))].sort(), [
		"meta-q3-2026",
		"tsla-q3-2026",
	]);
	const tsla = listed.find(
		(m) => m.eventKey === "tsla-q3-2026" && m.conditionKey === "above-0-43",
	);
	// The id the pool manager gives that market's probability pool, read back from the chain.
	assert.equal(
		tsla?.probability.id,
		"0x510f70d58ebda3b05313716b2c608b7a71a984071d34ab6cac42bfac52dac3ff",
	);
	// The pool opened at an even chance, as the record took it from the receipts.
	assert.equal(tsla?.opened?.sqrtPriceX96, Q96);
	for (const m of listed) {
		assert.ok(m.opened, m.conditionKey);
		assert.ok(m.sealTx?.startsWith("0x"), m.conditionKey);
		assert.notEqual(m.yesPool.id, m.noPool.id);
	}
});

test("every recorded event has its facts in the manifest, with one primary condition", () => {
	for (const key of ["meta-q3-2026", "tsla-q3-2026"]) {
		const facts = manifest.events.find((e) => e.eventKey === key);
		assert.ok(facts, key);
		assert.equal(facts.conditions.filter((c) => c.primary).length, 1, key);
	}
});

test("a chance history is the pool's opening, its trades in order, and where it stands now", () => {
	const points = historyOf(
		[
			{ kind: "opened", sqrtPriceX96: Q96, at: 1_000 },
			{ kind: "trade", sqrtPriceX96: Q96 * 2n, at: 2_000 },
		],
		true,
		Q96 * 2n,
		3_000,
	);
	assert.deepEqual(
		points.map((p) => [p.at, p.source]),
		[
			[1_000, "opened"],
			[2_000, "trade"],
			[3_000, "now"],
		],
	);
	assert.equal(points[0]?.chance, 0.5);
	assert.equal(historyOf([], true, undefined, 1).length, 0);
});

test("the feed's id for a ticker is the hash of the upper-case symbol", () => {
	assert.equal(priceIdOf("tsla"), priceIdOf("TSLA"));
});

test("the resolver's record of an event keeps only the rounds someone proposed in", () => {
	const empty = {
		proposer: "0x0000000000000000000000000000000000000000",
		proposedAt: 0n,
		invalid: false,
		settled: false,
		figure: 0n,
		decimals: 0,
		disputer: "0x0000000000000000000000000000000000000000",
		ruled: false,
		reason: "",
	};
	assert.deepEqual(
		resolutionFromChain({
			round: 0,
			pendingArbitration: false,
			rounds: [empty, empty],
		}).proposals,
		[],
	);
	const proposed = resolutionFromChain({
		round: 0,
		pendingArbitration: false,
		rounds: [
			{
				...empty,
				proposer: "0x18fC5360598FeED231B2A4936ab72bfc4daA34B7",
				proposedAt: 1_792_620_000n,
				figure: 47n,
				decimals: 2,
			},
			empty,
		],
	});
	const shown = resolutionOf(proposed, 0);
	assert.equal(shown.outcome, "unresolved");
	assert.equal(shown.rounds.length, 1);
	assert.equal(shown.rounds[0]?.figure, 47n);
	assert.equal(shown.rounds[0]?.disputer, undefined);
	assert.equal(resolutionOf(proposed, 1).outcome, "yes");
});
