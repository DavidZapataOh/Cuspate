/**
 * The ticket's chain reads against a market opened on a fork of the test network: the quote, the
 * room left, the wallet's dollars and the check of a whole purchase before anything is signed.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { parseAbi } from "viem";
import {
	BUYER,
	type Fork,
	openMarket,
	startTestnetFork,
} from "../../e2e/fork/testnet.ts";
import {
	chainClient,
	checkPurchase,
	fundsOf,
	quoteShares,
	roomCents,
} from "../../src/chain/market.ts";
import { contracts } from "../../src/chain/record.ts";
import type { MarketBinding } from "../../src/data/model.ts";
import {
	centsToDollarUnits,
	deadlineFor,
	entryCalls,
	floorOf,
} from "../../src/ticket/order.ts";

const ANNOUNCES = "2026-10-21T20:00:00Z";
const spec = {
	eventKey: "meta-q3-2026",
	conditionKey: "above-6-39",
	ticker: "META",
	period: { quarter: 3, fiscalYear: 2026 },
	threshold: 639n,
	announcesAt: ANNOUNCES,
	yesWorldPriceCents: 77_155n,
	noWorldPriceCents: 74_110n,
} as const;
const EMPTY = "0x00000000000000000000000000000000000e3e3e";

let fork: Fork;
let market: MarketBinding;
let client: ReturnType<typeof chainClient>;

before(async () => {
	fork = await startTestnetFork();
	client = chainClient(fork.url);
	market = (await openMarket(fork, spec)).binding;
	await fork.fund(contracts.dollar, BUYER, centsToDollarUnits(100_000n));
});
after(() => fork?.stop());

async function purchase(account: `0x${string}`, cents: bigint) {
	const dollars = centsToDollarUnits(cents);
	const quoted = await quoteShares(client, market.legs, true, dollars);
	assert.ok(
		"shares" in quoted,
		JSON.stringify(quoted, (_, v) => String(v)),
	);
	const now = (await client.getBlock()).timestamp;
	const funds = await fundsOf(client, account);
	return {
		quoted: quoted.shares,
		calls: entryCalls({
			router: contracts.router,
			dollar: contracts.dollar,
			marketId: market.marketId,
			yes: true,
			dollars,
			minShares: floorOf(quoted.shares),
			recipient: account,
			deadline: deadlineFor(now, BigInt(Date.parse(ANNOUNCES) / 1000)),
			allowance: funds.allowance,
		}),
	};
}

test("the quote for $500 buys what the condition's price says, less the pools' fee", async () => {
	const quoted = await quoteShares(
		client,
		market.legs,
		true,
		centsToDollarUnits(50_000n),
	);
	assert.ok("shares" in quoted);
	const shares = Number(quoted.shares) / 1e18;
	const expected = (500 * 0.997) / 771.55;
	assert.ok(
		Math.abs(shares - expected) / expected < 0.02,
		`${shares} shares against ${expected}`,
	);
});

test("a funded buyer's approval and purchase check out together before anything is signed", async () => {
	const { calls } = await purchase(BUYER, 50_000n);
	assert.equal(calls.length, 2);
	assert.equal(await checkPurchase(client, BUYER, calls), undefined);
});

test("a buyer without test dollars is told how many more, before signing", async () => {
	const { calls } = await purchase(EMPTY, 50_000n);
	assert.deepEqual(await checkPurchase(client, EMPTY, calls), {
		kind: "short",
		needCents: 50_000n,
	});
	assert.deepEqual(await fundsOf(client, EMPTY), {
		balance: 0n,
		allowance: 0n,
	});
});

test("the room left is the dollar vault's cap less what it holds", async () => {
	// Opened with ten million dollars of room, two hundred thousand of them seeded.
	assert.equal(await roomCents(client, market.dollarVault), 980_000_000n);
	const full = await openMarket(fork, {
		...spec,
		conditionKey: "above-7-27",
		threshold: 727n,
		dollarCap: 200_100n * 10n ** 6n,
	});
	assert.equal(await roomCents(client, full.binding.dollarVault), 10_000n);
	const saved = market;
	market = full.binding;
	try {
		const { calls } = await purchase(BUYER, 50_000n);
		assert.deepEqual(await checkPurchase(client, BUYER, calls), {
			kind: "full",
			roomCents: 10_000n,
		});
	} finally {
		market = saved;
	}
});

test("a purchase sent after its check lands at or above its floor, with the dollars kept", async () => {
	const { calls, quoted } = await purchase(BUYER, 50_000n);
	for (const call of calls) {
		const hash = await fork.client.sendTransaction({
			account: BUYER,
			to: call.to,
			data: call.data,
			chain: null,
		});
		const receipt = await fork.client.waitForTransactionReceipt({ hash });
		assert.equal(receipt.status, "success");
	}
	const balanceOf = parseAbi([
		"function balanceOf(address) view returns (uint256)",
	]);
	const shares = await client.readContract({
		address: market.legs.underlyingYes,
		abi: balanceOf,
		functionName: "balanceOf",
		args: [BUYER],
	});
	const kept = await client.readContract({
		address: market.legs.dollarNo,
		abi: balanceOf,
		functionName: "balanceOf",
		args: [BUYER],
	});
	assert.ok(shares >= floorOf(quoted));
	assert.equal(kept, centsToDollarUnits(50_000n));
});

test("once the announcement passes, the quote says trading closed and when", async () => {
	await fork.client.setNextBlockTimestamp({
		timestamp: BigInt(Date.parse(ANNOUNCES) / 1000) + 60n,
	});
	await fork.client.mine({ blocks: 1 });
	const quoted = await quoteShares(
		client,
		market.legs,
		true,
		centsToDollarUnits(50_000n),
	);
	assert.deepEqual(quoted, {
		problem: { kind: "closed", at: Date.parse(ANNOUNCES) / 1000 },
	});
});
