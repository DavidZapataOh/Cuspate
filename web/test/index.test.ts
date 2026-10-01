import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLegPrice } from "../src/index.js";

test("a leg price is formatted in the quote asset's own units", () => {
	assert.equal(formatLegPrice(1040000000n, 6), "1040.000000");
	assert.equal(formatLegPrice(717013562000000000n, 18), "0.717013562000000000");
});
