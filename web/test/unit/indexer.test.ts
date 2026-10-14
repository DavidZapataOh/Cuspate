import assert from "node:assert/strict";
import { test } from "node:test";
import { logPlace, marketsFrom, query } from "../../src/data/indexer.ts";

const market = {
	id: "0xm",
	eventId: "0xe",
	condition: "0xc",
	underlyingVault: "0xu",
	dollarVault: "0xd",
};

test("a market is joined with its seal, its pools, the dollars in its vault and its outcome", () => {
	const [m] = marketsFrom({
		Market: [market],
		Seal: [
			{
				id: "0xe",
				sealBlock: "70830201",
				value: "43",
				decimals: 2,
				announcesAt: "1792612800",
				deadline: "1792958400",
			},
		],
		Pool: [
			{
				id: "0xp",
				market: "0xm",
				kind: "probability",
				currency0: "0x1",
				currency1: "0x2",
				freezesAt: "1792612800",
			},
			{
				id: "0xq",
				market: "0xother",
				kind: "yes",
				currency0: "0x1",
				currency1: "0x2",
				freezesAt: "0",
			},
		],
		Vault: [{ id: "0xd", yes: "0xyes" }],
		Leg: [{ id: "0xyes", supply: "20000000000" }],
		Condition: [{ id: "0xc", outcome: 2 }],
	});
	assert.ok(m);
	assert.equal(m.seal?.value, 43n);
	assert.equal(m.seal?.sealBlock, 70830201n);
	assert.deepEqual(
		m.pools.map((p) => p.id),
		["0xp"],
	);
	assert.equal(m.dollarsIn, 20_000_000_000n);
	assert.equal(m.outcome, 2);
});

test("a market with nothing indexed beyond itself has no seal, no dollars and no outcome", () => {
	const [m] = marketsFrom({
		Market: [market],
		Seal: [],
		Pool: [],
		Vault: [],
		Leg: [],
		Condition: [],
	});
	assert.equal(m?.seal, undefined);
	assert.equal(m?.dollarsIn, 0n);
	assert.equal(m?.outcome, 0);
});

test("a log's indexer id is its block and its index in the block", () => {
	assert.deepEqual(logPlace("70837082-14"), {
		block: 70837082n,
		logIndex: 14,
	});
});

test("without INDEXER_GRAPHQL_URL nothing is asked, and the read says why", async () => {
	const saved = process.env.INDEXER_GRAPHQL_URL;
	delete process.env.INDEXER_GRAPHQL_URL;
	try {
		await assert.rejects(query("{ Market { id } }"), /INDEXER_GRAPHQL_URL/);
	} finally {
		if (saved !== undefined) process.env.INDEXER_GRAPHQL_URL = saved;
	}
});

test("an answer with errors is refused, not read as empty", async () => {
	process.env.INDEXER_GRAPHQL_URL ??= "http://indexer.invalid/v1/graphql";
	const answer = (body: unknown) =>
		(async () => new Response(JSON.stringify(body))) as typeof fetch;
	await assert.rejects(
		query("{ Market { id } }", {}, answer({ errors: [{ message: "bad" }] })),
		/bad/,
	);
	assert.deepEqual(
		await query("{ Market { id } }", {}, answer({ data: { Market: [] } })),
		{ Market: [] },
	);
});

test("a position is the address's indexed balance of each of the market's legs", async () => {
	const { positionFrom } = await import("../../src/portfolio/indexed.ts");
	const a = (n: number) =>
		`0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
	const listed = {
		eventKey: "tsla-q3-2026",
		conditionKey: "above-0-43",
		issuer: "TSLA",
		market: {
			marketId: `0x${"22".repeat(32)}` as `0x${string}`,
			dollarVault: a(3),
			legs: {
				underlyingYes: a(4),
				underlyingNo: a(5),
				dollarYes: a(6),
				dollarNo: a(7),
			},
		},
	};
	const position = positionFrom(
		a(9),
		listed,
		{
			id: listed.market.marketId,
			eventId: "0xe",
			condition: "0xc",
			underlyingVault: a(2),
			dollarVault: a(3),
			pools: [
				{
					id: "0xp",
					market: listed.market.marketId,
					kind: "yes",
					currency0: a(4),
					currency1: a(6),
					freezesAt: 1_792_612_800n,
				},
			],
			dollarsIn: 0n,
			outcome: 0,
			resolution: { round: 0, pendingArbitration: false, proposals: [] },
		},
		new Map([
			[a(4), 5n],
			[a(7), 9n],
		]),
	);
	assert.deepEqual(position.holdings, {
		underlyingYes: 5n,
		underlyingNo: 0n,
		dollarYes: 0n,
		dollarNo: 9n,
	});
	assert.equal(position.freezesAt, 1_792_612_800);
	assert.equal(position.outcome, "unresolved");
});
