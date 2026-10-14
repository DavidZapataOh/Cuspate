import assert from "node:assert/strict";
import { test } from "node:test";
import { privyGateway, statusOf } from "../../src/server/privy.ts";
import {
	type SponsorGateway,
	sessionAccount,
	unavailable,
} from "../../src/server/sponsor.ts";
import { expiryOf } from "../../src/wallet/email.ts";

const wallet = "0x00000000000000000000000000000000000000Aa";
const gateway: SponsorGateway = {
	userOf: async (token) =>
		token === "good" ? { walletId: "w1", address: wallet } : undefined,
	execute: async () => ({ transactionId: "t1" }),
	status: async () => "pending",
};
const asking = (token?: string) =>
	new Request("http://localhost/api/session", {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});

test("a session names the wallet the verified user holds, and nothing for anyone else", async () => {
	const ok = await sessionAccount(asking("good"), gateway);
	assert.equal(ok.status, 200);
	assert.deepEqual(await ok.json(), { address: wallet });
	assert.equal((await sessionAccount(asking("bad"), gateway)).status, 401);
	assert.equal((await sessionAccount(asking(), gateway)).status, 401);
	assert.equal((await sessionAccount(asking("good"), unavailable)).status, 503);
});

test("without the app's id and secret the gateway refuses everything", () => {
	assert.equal(privyGateway({}), unavailable);
	assert.equal(privyGateway({ NEXT_PUBLIC_PRIVY_APP_ID: "app" }), unavailable);
});

test("the provider's transaction states read as pending, confirmed or failed", () => {
	assert.equal(statusOf("confirmed"), "confirmed");
	assert.equal(statusOf("finalized"), "confirmed");
	for (const s of [
		"execution_reverted",
		"failed",
		"replaced",
		"provider_error",
	])
		assert.equal(statusOf(s), "failed");
	assert.equal(statusOf("broadcasted"), "pending");
	assert.equal(statusOf("pending"), "pending");
});

test("a session token's expiry is read from it, and an unreadable token has none", () => {
	const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString(
		"base64url",
	);
	assert.equal(expiryOf(`h.${payload}.s`), 2_000_000_000_000);
	assert.equal(expiryOf("nonsense"), 0);
});
