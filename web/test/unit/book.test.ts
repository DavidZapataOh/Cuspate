import assert from "node:assert/strict";
import { test } from "node:test";
import { marketsOf } from "../../src/data/book.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const record = {
	eventKey: "meta-q3-2026",
	condition: "above-6-39",
	issuer: "META",
	threshold: "6.39",
	eventId: `0x${"11".repeat(32)}`,
	marketId: `0x${"22".repeat(32)}`,
	stock: a(1),
	underlyingVault: a(2),
	dollarVault: a(3),
	legs: {
		underlyingYes: a(4),
		underlyingNo: a(5),
		dollarYes: a(6),
		dollarNo: a(7),
	},
};

test("a deployment record's markets are read by event and condition, with what a purchase needs", () => {
	const markets = marketsOf({ markets: { "meta-q3-2026/above-6-39": record } });
	assert.deepEqual(markets.get("meta-q3-2026/above-6-39"), {
		marketId: record.marketId,
		dollarVault: "0x0000000000000000000000000000000000000003",
		legs: {
			underlyingYes: "0x0000000000000000000000000000000000000004",
			underlyingNo: "0x0000000000000000000000000000000000000005",
			dollarYes: "0x0000000000000000000000000000000000000006",
			dollarNo: "0x0000000000000000000000000000000000000007",
		},
	});
	assert.equal(marketsOf({}).size, 0);
});

test("a market recorded without its id or its tokens is refused, not half-used", () => {
	assert.throws(
		() =>
			marketsOf({
				markets: { "meta-q3-2026/above-6-39": { ...record, marketId: "0x12" } },
			}),
		/meta-q3-2026\/above-6-39/,
	);
	const { legs: _, ...noLegs } = record;
	assert.throws(
		() => marketsOf({ markets: { "meta-q3-2026/above-6-39": noLegs } }),
		/meta-q3-2026\/above-6-39/,
	);
});
