import assert from "node:assert/strict";
import { test } from "node:test";
import { sponsoredExecutor } from "../../src/ticket/executor.ts";

const calls = [
	{ to: "0x00000000000000000000000000000000000000aa", data: "0x", value: 0n },
] as const;

test("a sponsored purchase posts the batch with the session and follows the transaction the server names", async () => {
	const seen: { url: string; init?: RequestInit }[] = [];
	const statuses = ["pending", "pending", "confirmed"];
	const fetcher = async (url: string, init?: RequestInit) => {
		seen.push({ url, init });
		if (url === "/api/sponsor") return Response.json({ transactionId: "tx-1" });
		return Response.json({ status: statuses.shift() });
	};
	const executor = sponsoredExecutor({
		token: async () => "session",
		fetcher,
		pollMs: 1,
	});
	const submitted = await executor.send([...calls]);
	assert.deepEqual(submitted, { id: "tx-1" });
	assert.deepEqual(await executor.settle(submitted), { status: "confirmed" });
	assert.equal(seen[0]?.init?.method, "POST");
	const headers = (seen[0]?.init?.headers ?? {}) as Record<string, string>;
	assert.equal(headers.authorization, "Bearer session");
	assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), {
		calls: [{ to: calls[0].to, data: "0x", value: "0" }],
	});
	assert.equal(seen[1]?.url, "/api/sponsor/status?id=tx-1");
	assert.equal(seen.length, 4);
});

test("a refusal from the server reaches the buyer in its own words; a failed transaction is a failure", async () => {
	const executor = sponsoredExecutor({
		token: async () => "session",
		fetcher: async (url: string) =>
			url === "/api/sponsor"
				? Response.json(
						{
							message: "Email sign-in opens soon. Connect a wallet to buy now.",
						},
						{ status: 503 },
					)
				: Response.json({ status: "failed" }),
		pollMs: 1,
	});
	await assert.rejects(executor.send([...calls]), /Email sign-in opens soon/);
	assert.deepEqual(await executor.settle({ id: "tx-2" }), { status: "failed" });
});

test("a transaction that never settles is reported as failed after the wait, not left spinning", async () => {
	const executor = sponsoredExecutor({
		token: async () => "session",
		fetcher: async () => Response.json({ status: "pending" }),
		pollMs: 1,
		timeoutMs: 20,
	});
	assert.deepEqual(await executor.settle({ id: "tx-3" }), { status: "failed" });
});
