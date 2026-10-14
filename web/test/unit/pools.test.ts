import assert from "node:assert/strict";
import { test } from "node:test";
import {
	POOL_FEE,
	poolKeyOf,
	TICK_SPACING,
	worldPool,
} from "../../src/chain/pools.ts";

const hook = "0x00000000000000000000000000000000000020a0";
const legs = {
	underlyingYes: "0x00000000000000000000000000000000000000b1",
	underlyingNo: "0x00000000000000000000000000000000000000a1",
	dollarYes: "0x00000000000000000000000000000000000000c1",
	dollarNo: "0x0000000000000000000000000000000000000001",
} as const;

test("a pool's key is its pair in address order, the protocol's fee and spacing, and the hook", () => {
	assert.deepEqual(poolKeyOf(legs.dollarYes, legs.underlyingYes, hook), {
		currency0: legs.underlyingYes,
		currency1: legs.dollarYes,
		fee: POOL_FEE,
		tickSpacing: TICK_SPACING,
		hooks: hook,
	});
	assert.equal(POOL_FEE, 3000);
	assert.equal(TICK_SPACING, 60);
});

test("buying in a world sells that world's dollar for that world's share, in its own pool", () => {
	const yes = worldPool(legs, true, hook);
	assert.equal(yes.key.currency0, legs.underlyingYes);
	// The dollar leg is currency1 here, so the sale runs one for zero.
	assert.equal(yes.zeroForOne, false);
	const no = worldPool(legs, false, hook);
	assert.equal(no.key.currency0, legs.dollarNo);
	assert.equal(no.zeroForOne, true);
});
