import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getAddress } from "viem";
import { contracts, stockOf, TESTNET } from "../../src/chain/record.ts";

const record = JSON.parse(
	readFileSync(
		new URL("../../../contracts/deployments/10143.json", import.meta.url),
		"utf8",
	),
);

test("the interface reads the test network's contracts from its deployment record, by name", () => {
	assert.equal(TESTNET.id, 10143);
	assert.equal(contracts.router, getAddress(record.PositionRouter.address));
	assert.equal(contracts.factory, getAddress(record.MarketFactory.address));
	assert.equal(contracts.hook, getAddress(record.FreezeHook.address));
	assert.equal(contracts.dollar, getAddress(record.TestnetDollar.address));
	assert.equal(contracts.quoter, getAddress(record.thirdParty.v4Quoter[0]));
	assert.equal(
		stockOf("META"),
		getAddress(record["TestnetStock.META"].address),
	);
});

test("a stock the record does not hold is refused, not guessed", () => {
	assert.throws(() => stockOf("XYZ"), /XYZ/);
});
