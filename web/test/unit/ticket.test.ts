import assert from "node:assert/strict";
import { test } from "node:test";
import { POOL_FEE_BPS, parseAmount, preview } from "../../src/lib/ticket.ts";

test("dollars in buy the shares of the yes world at its price, net of the pool fee, and come back whole in the other", () => {
	// $500 at a yes-world price of $400.00: 500 * (1 - 0.003) / 400 shares.
	const p = preview({ amountCents: 50_000n, yesPriceCents: 40_000n });
	assert.equal(POOL_FEE_BPS, 30n);
	assert.equal(p.feeCents, 150n);
	assert.equal(p.shares, 1.24625);
	assert.equal(p.backCents, 50_000n);
});

test("nothing typed is nothing bought", () => {
	const p = preview({ amountCents: 0n, yesPriceCents: 40_000n });
	assert.equal(p.shares, 0);
	assert.equal(p.feeCents, 0n);
});

test("an amount is read as dollars and cents, with or without separators", () => {
	assert.equal(parseAmount("500"), 50_000n);
	assert.equal(parseAmount("12.5"), 1_250n);
	assert.equal(parseAmount(" 1,250.05 "), 125_005n);
	assert.equal(parseAmount("0"), 0n);
});

test("anything that is not an amount of dollars is refused, not guessed", () => {
	for (const text of ["", "abc", "1.234", "-5", "5e3", "$500"]) {
		assert.equal(parseAmount(text), undefined, text);
	}
});

test("buying the other world prices its shares at that world's price, and gives the dollars back in the first", () => {
	const p = preview({
		amountCents: 50_000n,
		yesPriceCents: 10_000n,
		noPriceCents: 9_000n,
		yes: false,
	});
	assert.equal(p.feeCents, 150n);
	assert.ok(Math.abs(p.shares - 49_850 / 9_000) < 1e-9);
	assert.equal(p.backCents, 50_000n);
});
