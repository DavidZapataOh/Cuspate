import assert from "node:assert/strict";
import { test } from "node:test";
import record from "../../../contracts/deployments/10143.json" with {
	type: "json",
};
import { contracts, keys } from "../../src/lib/keys.ts";

test("every privileged account shown is the one the deployment recorded", () => {
	const roles = (record as { roles: Record<string, { address: string }> })
		.roles;
	const shown = keys();
	assert.ok(shown.length >= 4);
	for (const k of shown) assert.equal(k.address, roles[k.role]?.address);
});

test("the contracts listed carry their creating transaction", () => {
	for (const c of contracts()) assert.match(c.txHash, /^0x[0-9a-f]{64}$/);
});
