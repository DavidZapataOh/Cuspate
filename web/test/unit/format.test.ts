import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatChance,
	formatCountdown,
	formatShares,
	formatUsd,
} from "../../src/lib/format.ts";

test("dollars are shown with cents and thousands, from integer cents", () => {
	assert.equal(formatUsd(50000n), "$500.00");
	assert.equal(formatUsd(1241050n), "$12,410.50");
	assert.equal(formatUsd(5n), "$0.05");
	assert.equal(formatUsd(-150n), "-$1.50");
});

test("a chance is a whole percentage, never 0% or 100% while the market is open", () => {
	assert.equal(formatChance(0.641), "64%");
	assert.equal(formatChance(0.004), "<1%");
	assert.equal(formatChance(0.996), ">99%");
	assert.equal(formatChance(0.5), "50%");
});

test("a countdown names days, hours and minutes, and says when it has run out", () => {
	const minute = 60_000;
	assert.equal(
		formatCountdown((8 * 24 * 60 + 4 * 60 + 12) * minute),
		"8d 4h 12m",
	);
	assert.equal(formatCountdown((4 * 60 + 12) * minute), "4h 12m");
	assert.equal(formatCountdown(12 * minute), "12m");
	assert.equal(formatCountdown(30_000), "under 1m");
	assert.equal(formatCountdown(0), "now");
	assert.equal(formatCountdown(-5), "now");
});

test("shares are shown to at most four decimals, without trailing zeros", () => {
	assert.equal(formatShares(0.41), "0.41");
	assert.equal(formatShares(7.123456), "7.1235");
	assert.equal(formatShares(2), "2");
});
