import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, parseAbi } from "viem";
import { contracts } from "../../src/chain/record.ts";
import {
	batchRefusal,
	type SponsorGateway,
	sponsorPost,
	sponsorStatus,
	unavailable,
} from "../../src/server/sponsor.ts";

const abi = parseAbi([
	"function approve(address spender, uint256 amount) returns (bool)",
	"function enter(bytes32 marketId, bool yes, uint256 dollars, uint256 minShares, address recipient, uint256 deadline) returns (uint256)",
	"function drip()",
	"function transfer(address to, uint256 amount) returns (bool)",
]);
const user = "0x00000000000000000000000000000000000000aa";
const enter = {
	to: contracts.router,
	value: "0",
	data: encodeFunctionData({
		abi,
		functionName: "enter",
		args: [
			`0x${"22".repeat(32)}`,
			true,
			500_000_000n,
			1n,
			user,
			2_000_000_000n,
		],
	}),
};
const approve = (spender: `0x${string}`) => ({
	to: contracts.dollar,
	value: "0",
	data: encodeFunctionData({
		abi,
		functionName: "approve",
		args: [spender, 500_000_000n],
	}),
});
const drip = {
	to: contracts.dollar,
	value: "0",
	data: encodeFunctionData({ abi, functionName: "drip" }),
};

test("a purchase, its approval to the router, and the test dollars' drip are batches the server pays for", () => {
	assert.equal(batchRefusal([approve(contracts.router), enter]), undefined);
	assert.equal(batchRefusal([enter]), undefined);
	assert.equal(batchRefusal([drip]), undefined);
});

test("anything else is refused: another spender, a transfer, value, an empty or long batch, a purchase not last", () => {
	const refusals = [
		[approve(user), enter],
		[
			{
				to: contracts.dollar,
				value: "0",
				data: encodeFunctionData({
					abi,
					functionName: "transfer",
					args: [user, 1n],
				}),
			},
		],
		[{ ...enter, value: "1" }],
		[],
		[
			approve(contracts.router),
			approve(contracts.router),
			approve(contracts.router),
			enter,
		],
		[enter, approve(contracts.router)],
		[{ ...enter, to: user }],
	];
	for (const calls of refusals)
		assert.ok(batchRefusal(calls), JSON.stringify(calls));
});

function gateway(over: Partial<SponsorGateway> = {}): SponsorGateway {
	return {
		userOf: async (token) =>
			token === "good"
				? { walletId: "wallet-of-the-session", address: user }
				: undefined,
		execute: async (walletId) => ({ transactionId: `tx-for-${walletId}` }),
		status: async (id) =>
			id === "tx-for-wallet-of-the-session" ? "confirmed" : "pending",
		...over,
	};
}
const fine = async () => undefined;
const post = (body: unknown, token?: string) =>
	new Request("http://localhost/api/sponsor", {
		method: "POST",
		headers: token ? { authorization: `Bearer ${token}` } : {},
		body: JSON.stringify(body),
	});

test("the server sends a checked batch from the session's own wallet and answers with the transaction to follow", async () => {
	const response = await sponsorPost(
		post(
			{ calls: [approve(contracts.router), enter], walletId: "someone-else" },
			"good",
		),
		gateway(),
		fine,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		transactionId: "tx-for-wallet-of-the-session",
	});
	const status = await sponsorStatus(
		new Request(
			"http://localhost/api/sponsor/status?id=tx-for-wallet-of-the-session",
			{
				headers: { authorization: "Bearer good" },
			},
		),
		gateway(),
	);
	assert.deepEqual(await status.json(), { status: "confirmed" });
});

test("no session, a refused batch, or a batch the chain would refuse is never paid for", async () => {
	let executed = 0;
	const counting = gateway({
		execute: async () => {
			executed++;
			return { transactionId: "x" };
		},
	});
	const anonymous = await sponsorPost(post({ calls: [enter] }), counting, fine);
	assert.equal(anonymous.status, 401);
	const refused = await sponsorPost(
		post({ calls: [approve(user), enter] }, "good"),
		counting,
		fine,
	);
	assert.equal(refused.status, 400);
	const failing = await sponsorPost(
		post({ calls: [enter] }, "good"),
		counting,
		async () => ({ kind: "short", needCents: 100n }),
	);
	assert.equal(failing.status, 400);
	assert.deepEqual(await failing.json(), {
		message: "You need $1.00 more. Nothing was charged.",
	});
	assert.equal(executed, 0);
});

test("until sign-in with an email is connected, the server says so plainly and pays for nothing", async () => {
	const response = await sponsorPost(
		post({ calls: [enter] }, "good"),
		unavailable,
		fine,
	);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), {
		message:
			"Email sign-in is not available right now. Connect a wallet to buy.",
	});
});
