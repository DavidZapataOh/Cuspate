import assert from "node:assert/strict";
import { test } from "node:test";
import { outcomes } from "../../src/lib/compare.ts";

test("the same dollars put into the stock and into the condition", () => {
	const o = outcomes({
		amountCents: 100_000n,
		spotCents: 40_000n,
		metWorldPriceCents: 40_000n,
		afterCents: 44_000n,
	});
	assert.equal(o.stockShares, 2.5);
	assert.equal(o.feeCents, 300);
	assert.equal(o.conditionalShares, 99_700 / 40_000);
	assert.equal(o.stockValueCents, 110_000);
	assert.equal(o.notMetValueCents, 100_000);
	assert.equal(o.callShares, undefined);
});

test("a call option the visitor prices pays only above its strike", () => {
	const base = {
		amountCents: 100_000n,
		spotCents: 40_000n,
		metWorldPriceCents: 40_000n,
		premiumCents: 2_000n,
		strikeCents: 42_000n,
	};
	const up = outcomes({ ...base, afterCents: 44_000n });
	assert.equal(up.callShares, 50);
	assert.equal(up.callValueCents, 100_000);
	const down = outcomes({ ...base, afterCents: 41_000n });
	assert.equal(down.callValueCents, 0);
});

test("no price means no shares, never a division by zero", () => {
	const o = outcomes({
		amountCents: 100_000n,
		spotCents: 0n,
		metWorldPriceCents: 0n,
		afterCents: 1n,
		premiumCents: 0n,
		strikeCents: 1n,
	});
	assert.equal(o.stockShares, 0);
	assert.equal(o.conditionalShares, 0);
	assert.equal(o.callShares, undefined);
});
