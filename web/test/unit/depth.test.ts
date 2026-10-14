import assert from "node:assert/strict";
import { test } from "node:test";
import { largestQuoted } from "../../src/chain/market.ts";

test("the largest quoted amount is found to the whole dollar", async () => {
	const depth = 10_812_345_678n;
	let asked = 0;
	const most = await largestQuoted(async (amount) => {
		asked++;
		return amount <= depth;
	}, 50_000_000_000n);
	assert.equal(most, 10_812_000_000n);
	assert.ok(asked <= 17, `${asked} quotes`);
});

test("nothing is quoted when even a dollar is refused", async () => {
	assert.equal(await largestQuoted(async () => false, 5_000_000n), 0n);
});
