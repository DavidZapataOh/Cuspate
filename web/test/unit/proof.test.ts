import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	freshProof,
	PROOF_MAX_AGE_MS,
	proofMessage,
	QUOTE_WINDOW_MS,
	QUOTES_PER_WINDOW,
	takeSlot,
} from "../../src/funding/proof.ts";

// A well-known development key that holds nothing anywhere real.
const account = privateKeyToAccount(
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

test("a signature over the request's message proves the address, and only that address", async () => {
	const at = 1_792_000_000_000;
	const message = proofMessage(account.address, at);
	const signature = await account.signMessage({ message });
	assert.equal(
		await verifyMessage({ address: account.address, message, signature }),
		true,
	);
	assert.equal(
		await verifyMessage({
			address: "0x2222222222222222222222222222222222222222",
			message,
			signature,
		}),
		false,
	);
	assert.equal(
		proofMessage(account.address, at),
		proofMessage(account.address.toLowerCase(), at),
	);
});

test("a signature is good for five minutes and never from the future", () => {
	const now = 1_792_000_000_000;
	assert.equal(freshProof(now - PROOF_MAX_AGE_MS, now), true);
	assert.equal(freshProof(now - PROOF_MAX_AGE_MS - 1, now), false);
	assert.equal(freshProof(now + 5 * 60_000, now), false);
	assert.equal(freshProof(Number.NaN, now), false);
});

test("an address takes a few deposit addresses per window, then waits", () => {
	const log = new Map<string, number[]>();
	const now = 1_000_000;
	for (let i = 0; i < QUOTES_PER_WINDOW; i++)
		assert.deepEqual(takeSlot(log, "0xAbC", now + i), { ok: true });
	assert.deepEqual(takeSlot(log, "0xabc", now + 10), {
		ok: false,
		retryAt: now + QUOTE_WINDOW_MS,
	});
	assert.deepEqual(takeSlot(log, "0xdef", now + 10), { ok: true });
	assert.deepEqual(takeSlot(log, "0xabc", now + QUOTE_WINDOW_MS + 1), {
		ok: true,
	});
});
