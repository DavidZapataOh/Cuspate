import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Address,
	encodeFunctionData,
	getAddress,
	type Hex,
	parseAbi,
} from "viem";
import { contracts } from "../../src/chain/record.ts";
import {
	DAILY_BATCHES_PER_USER,
	dayOf,
	MONTHLY_BATCHES_GLOBAL,
	monthOf,
	sponsorLimits,
	type Tally,
	type TallyKey,
	type TallyStore,
} from "../../src/server/limits.ts";
import {
	batchRefusal,
	recordedMarkets,
	type SponsorGateway,
	sponsorPost,
	sponsorStatus,
	unavailable,
} from "../../src/server/sponsor.ts";

const abi = parseAbi([
	"function approve(address spender, uint256 amount) returns (bool)",
	"function enter(bytes32 marketId, bool yes, uint256 dollars, uint256 minShares, address recipient, uint256 deadline) returns (uint256)",
	"function exit((bytes32 marketId, bool yes, uint256 shares, uint256 kept, uint256 minOut, bool levelSellsWorldDollar, uint256 level, uint256 minLevelOut, address recipient, uint256 deadline) order) returns (uint256 dollars)",
	"function redeemPositions(uint256 yesAmount, uint256 noAmount)",
	"function drip()",
	"function transfer(address to, uint256 amount) returns (bool)",
	"function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);
const user: Address = "0x00000000000000000000000000000000000000aa";
const stranger: Address = "0x00000000000000000000000000000000000000bb";
const market = recordedMarkets[0];
const other = recordedMarkets[1];
assert.ok(market && other, "the deployment record lists at least two markets");
const unrecorded: Hex = `0x${"22".repeat(32)}`;

type Wire = { to: Address; value: string; data: Hex };
const call = (to: Address, data: Hex): Wire => ({ to, value: "0", data });
const enter = (over: { marketId?: Hex; recipient?: Address } = {}) =>
	call(
		contracts.router,
		encodeFunctionData({
			abi,
			functionName: "enter",
			args: [
				over.marketId ?? market.marketId,
				true,
				500_000_000n,
				1n,
				over.recipient ?? user,
				2_000_000_000n,
			],
		}),
	);
const approve = (token: Address, spender: Address = contracts.router) =>
	call(
		token,
		encodeFunctionData({
			abi,
			functionName: "approve",
			args: [spender, 500_000_000n],
		}),
	);
const exit = (
	over: { marketId?: Hex; recipient?: Address; yes?: boolean } = {},
) =>
	call(
		contracts.router,
		encodeFunctionData({
			abi,
			functionName: "exit",
			args: [
				{
					marketId: over.marketId ?? market.marketId,
					yes: over.yes ?? true,
					shares: 10n,
					kept: 5n,
					minOut: 1n,
					levelSellsWorldDollar: false,
					level: 0n,
					minLevelOut: 0n,
					recipient: over.recipient ?? user,
					deadline: 2_000_000_000n,
				},
			],
		}),
	);
const redeem = (vault: Address) =>
	call(
		vault,
		encodeFunctionData({
			abi,
			functionName: "redeemPositions",
			args: [1n, 0n],
		}),
	);
const drip = call(
	contracts.dollar,
	encodeFunctionData({ abi, functionName: "drip" }),
);
// A yes position holds the yes share of the stock and the no world's dollar.
const undo = [
	approve(market.legs.underlyingYes),
	approve(market.legs.dollarNo),
	exit(),
];

test("the batches paid for are Cuspate's own: a purchase, an undo, a redemption and the test dollars' drip", () => {
	const paid = [
		[approve(contracts.dollar), enter()],
		[enter()],
		undo,
		[approve(market.legs.underlyingYes), exit()],
		[
			approve(market.legs.underlyingNo),
			approve(market.legs.dollarYes),
			exit({ yes: false }),
		],
		[redeem(market.underlyingVault), redeem(market.dollarVault)],
		[redeem(market.dollarVault)],
		[drip],
	];
	for (const calls of paid)
		assert.equal(batchRefusal(calls, user), undefined, JSON.stringify(calls));
});

test("a purchase or an undo that pays anyone but the session's wallet is refused", () => {
	assert.ok(batchRefusal([enter({ recipient: stranger })], user));
	assert.ok(
		batchRefusal(
			[approve(market.legs.underlyingYes), exit({ recipient: stranger })],
			user,
		),
	);
	// The recipient is compared as an address, not as text.
	assert.equal(
		batchRefusal([enter({ recipient: getAddress(user) })], user),
		undefined,
	);
});

test("a market the deployment record does not hold is refused, for entry, exit and redemption", () => {
	assert.ok(batchRefusal([enter({ marketId: unrecorded })], user));
	assert.ok(
		batchRefusal(
			[approve(market.legs.underlyingYes), exit({ marketId: unrecorded })],
			user,
		),
	);
	assert.ok(batchRefusal([redeem(stranger)], user));
	assert.ok(batchRefusal([redeem(contracts.router)], user));
});

test("an approval is paid for only to the router, of the token the call after it spends", () => {
	const refused = [
		// Another spender.
		[approve(contracts.dollar, stranger), enter()],
		[approve(market.legs.underlyingYes, stranger), exit()],
		// A token the purchase does not spend.
		[approve(market.legs.underlyingYes), enter()],
		// The undo spends the yes share and the no dollar of its own market, nothing else.
		[approve(contracts.dollar), exit()],
		[approve(market.legs.underlyingNo), exit()],
		[approve(market.legs.dollarYes), exit()],
		[approve(other.legs.underlyingYes), exit()],
		[approve(stranger), exit()],
		// The same approval twice, or an approval alone.
		[approve(contracts.dollar), approve(contracts.dollar), enter()],
		[
			approve(market.legs.underlyingYes),
			approve(market.legs.underlyingYes),
			exit(),
		],
		[approve(contracts.dollar)],
		// An approval in front of a redemption or the drip.
		[approve(contracts.dollar), drip],
		[approve(market.legs.dollarYes), redeem(market.dollarVault)],
	];
	for (const calls of refused)
		assert.ok(batchRefusal(calls, user), JSON.stringify(calls));
});

test("anything else is refused: a transfer, value, an empty or long batch, a call out of order, the wrong contract", () => {
	const refused = [
		[
			call(
				contracts.dollar,
				encodeFunctionData({
					abi,
					functionName: "transfer",
					args: [stranger, 1n],
				}),
			),
		],
		[
			call(
				market.legs.underlyingYes,
				encodeFunctionData({
					abi,
					functionName: "transferFrom",
					args: [user, stranger, 1n],
				}),
			),
		],
		[{ ...enter(), value: "1" }],
		[],
		[...undo, redeem(market.dollarVault)],
		[enter(), approve(contracts.dollar)],
		[enter(), enter()],
		[drip, drip],
		[drip, enter()],
		[redeem(market.dollarVault), redeem(market.dollarVault)],
		[{ ...enter(), to: stranger }],
		[{ ...exit(), to: contracts.dollar }],
		[{ ...drip, to: market.legs.dollarYes }],
		[{ ...drip, data: "nonsense" as Hex }],
		[{ ...drip, data: "0xdeadbeef" as Hex }],
	];
	for (const calls of refused)
		assert.ok(batchRefusal(calls, user), JSON.stringify(calls));
});

function gateway(over: Partial<SponsorGateway> = {}): SponsorGateway {
	return {
		userOf: async (token) =>
			token === "good"
				? { userId: "user-1", walletId: "wallet-of-the-session", address: user }
				: undefined,
		execute: async (walletId) => ({ transactionId: `tx-for-${walletId}` }),
		status: async (id) =>
			id === "tx-for-wallet-of-the-session"
				? { status: "confirmed", walletId: "wallet-of-the-session" }
				: { status: "pending", walletId: "someone-elses-wallet" },
		...over,
	};
}
const fine = async () => undefined;
const open = { reserve: async () => undefined };
const post = (body: unknown, token?: string) =>
	new Request("http://localhost/api/sponsor", {
		method: "POST",
		headers: token ? { authorization: `Bearer ${token}` } : {},
		body: JSON.stringify(body),
	});
const statusOf = (id: string) =>
	new Request(`http://localhost/api/sponsor/status?id=${id}`, {
		headers: { authorization: "Bearer good" },
	});

test("the server sends a checked batch from the session's own wallet and answers with the transaction to follow", async () => {
	const response = await sponsorPost(
		post(
			{ calls: [approve(contracts.dollar), enter()], walletId: "someone-else" },
			"good",
		),
		gateway(),
		fine,
		open,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		transactionId: "tx-for-wallet-of-the-session",
	});
	const status = await sponsorStatus(
		statusOf("tx-for-wallet-of-the-session"),
		gateway(),
	);
	assert.deepEqual(await status.json(), { status: "confirmed" });
});

test("a transaction is reported only to the session whose wallet sent it", async () => {
	const response = await sponsorStatus(statusOf("tx-of-another"), gateway());
	assert.equal(response.status, 404);
});

test("no session, a refused batch, or a batch the chain would refuse is never paid for nor counted", async () => {
	let executed = 0;
	let reserved = 0;
	const counting = gateway({
		execute: async () => {
			executed++;
			return { transactionId: "x" };
		},
	});
	const limits = {
		reserve: async () => {
			reserved++;
			return undefined;
		},
	};
	const anonymous = await sponsorPost(
		post({ calls: [enter()] }),
		counting,
		fine,
		limits,
	);
	assert.equal(anonymous.status, 401);
	const refused = await sponsorPost(
		post({ calls: [enter({ recipient: stranger })] }, "good"),
		counting,
		fine,
		limits,
	);
	assert.equal(refused.status, 403);
	assert.match(
		((await refused.json()) as { message: string }).message,
		/Nothing was sent/,
	);
	const failing = await sponsorPost(
		post({ calls: [enter()] }, "good"),
		counting,
		async () => ({ kind: "short", needCents: 100n }),
		limits,
	);
	assert.equal(failing.status, 400);
	assert.deepEqual(await failing.json(), {
		message: "You need $1.00 more. Nothing was charged.",
	});
	assert.equal(executed, 0);
	assert.equal(reserved, 0);
});

test("past a limit the server answers 429 plainly and sends nothing", async () => {
	let executed = 0;
	const counting = gateway({
		execute: async () => {
			executed++;
			return { transactionId: "x" };
		},
	});
	for (const reached of ["user", "global"] as const) {
		const response = await sponsorPost(
			post({ calls: [drip] }, "good"),
			counting,
			fine,
			{ reserve: async () => reached },
		);
		assert.equal(response.status, 429);
		const { message } = (await response.json()) as { message: string };
		assert.match(message, /Nothing was sent/);
	}
	assert.equal(executed, 0);
});

test("until sign-in with an email is connected, the server says so plainly and pays for nothing", async () => {
	const response = await sponsorPost(
		post({ calls: [enter()] }, "good"),
		unavailable,
		fine,
		open,
	);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), {
		message:
			"Email sign-in is not available right now. Connect a wallet to buy.",
	});
});

function memory(): TallyStore & { tallies: Map<string, Tally> } {
	const tallies = new Map<string, Tally>();
	const name = (key: TallyKey) => (key === "global" ? key : `user:${key.user}`);
	return {
		tallies,
		read: async (key) => tallies.get(name(key)),
		write: async (key, tally) => {
			tallies.set(name(key), tally);
		},
	};
}

test("the periods are the UTC day and the UTC month", () => {
	const late = new Date("2026-10-13T23:59:59.999Z");
	assert.equal(dayOf(late), "2026-10-13");
	assert.equal(monthOf(late), "2026-10");
	assert.equal(dayOf(new Date("2026-11-01T00:00:00Z")), "2026-11-01");
});

test("each user gets a daily number of paid batches, counted in the durable store, reset each UTC day", async () => {
	const store = memory();
	let now = new Date("2026-10-13T10:00:00Z");
	const limits = sponsorLimits(store, () => now);
	for (let i = 0; i < DAILY_BATCHES_PER_USER; i++)
		assert.equal(await limits.reserve("alice"), undefined);
	assert.equal(await limits.reserve("alice"), "user");
	assert.equal(await limits.reserve("bob"), undefined);
	assert.deepEqual(store.tallies.get("user:alice"), {
		period: "2026-10-13",
		count: DAILY_BATCHES_PER_USER,
	});
	now = new Date("2026-10-14T00:00:00Z");
	assert.equal(await limits.reserve("alice"), undefined);
	assert.deepEqual(store.tallies.get("user:alice"), {
		period: "2026-10-14",
		count: 1,
	});
});

test("all users share a monthly budget, which a refused user does not spend", async () => {
	const store = memory();
	let now = new Date("2026-10-31T23:00:00Z");
	const limits = sponsorLimits(store, () => now);
	await store.write("global", {
		period: "2026-10",
		count: MONTHLY_BATCHES_GLOBAL - 1,
	});
	assert.equal(await limits.reserve("alice"), undefined);
	assert.equal(await limits.reserve("bob"), "global");
	assert.equal(store.tallies.get("user:bob"), undefined);
	assert.deepEqual(store.tallies.get("global"), {
		period: "2026-10",
		count: MONTHLY_BATCHES_GLOBAL,
	});
	now = new Date("2026-11-01T00:00:00Z");
	assert.equal(await limits.reserve("bob"), undefined);
	assert.deepEqual(store.tallies.get("global"), {
		period: "2026-11",
		count: 1,
	});
});
