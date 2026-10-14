import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, parseAbi } from "viem";
import { poolIdOf } from "../../src/portfolio/chain.ts";
import {
	formatUnits4,
	holdsAny,
	type Position,
	payoutOf,
	phaseOf,
	redeemCalls,
	settlementOf,
	sidesOf,
	undoCalls,
	undoDollars,
} from "../../src/portfolio/position.ts";

const router = "0x80b38767D951170723291faC506348EFF7935a35";
const holder = "0x2222222222222222222222222222222222222222";
const abi = parseAbi([
	"function approve(address spender, uint256 amount) returns (bool)",
	"function redeemPositions(uint256 yesAmount, uint256 noAmount)",
	"function exit((bytes32 marketId, bool yes, uint256 shares, uint256 kept, uint256 minOut, bool levelSellsWorldDollar, uint256 level, uint256 minLevelOut, address recipient, uint256 deadline) order) returns (uint256 dollars)",
]);

function position(overrides: Partial<Position> = {}): Position {
	return {
		eventKey: "meta-q3-2026",
		conditionKey: "above-5-51",
		issuer: "META",
		holder,
		marketId: `0x${"ab".repeat(32)}`,
		underlyingVault: "0x3333333333333333333333333333333333333333",
		dollarVault: "0x4444444444444444444444444444444444444444",
		legs: {
			underlyingYes: "0x5555555555555555555555555555555555555555",
			underlyingNo: "0x6666666666666666666666666666666666666666",
			dollarYes: "0x7777777777777777777777777777777777777777",
			dollarNo: "0x8888888888888888888888888888888888888888",
		},
		holdings: {
			underlyingYes: 10n ** 17n,
			underlyingNo: 0n,
			dollarYes: 0n,
			dollarNo: 50_000_000n,
		},
		freezesAt: 2_000,
		outcome: "unresolved",
		...overrides,
	};
}

test("a position is open before the freeze, frozen after, settled once reported", () => {
	assert.equal(phaseOf(position(), 1_999), "open");
	assert.equal(phaseOf(position(), 2_000), "frozen");
	assert.equal(phaseOf(position({ outcome: "no" }), 1_000), "settled");
	assert.equal(phaseOf(position({ freezesAt: 0 }), 1), "frozen");
});

test("payouts follow the vault: winner one for one, loser nothing, invalid half each", () => {
	assert.equal(payoutOf("yes", 10n, 4n), 10n);
	assert.equal(payoutOf("no", 10n, 4n), 4n);
	assert.equal(payoutOf("invalid", 3n, 4n), 3n);
	assert.equal(payoutOf("unresolved", 10n, 4n), 0n);
	assert.deepEqual(settlementOf(position({ outcome: "yes" })), {
		shares: 10n ** 17n,
		dollars: 0n,
	});
	assert.deepEqual(settlementOf(position({ outcome: "no" })), {
		shares: 0n,
		dollars: 50_000_000n,
	});
	assert.deepEqual(settlementOf(position({ outcome: "invalid" })), {
		shares: 5n * 10n ** 16n,
		dollars: 25_000_000n,
	});
});

test("redeem calls each vault where something is held", () => {
	const calls = redeemCalls(position({ outcome: "yes" }));
	assert.equal(calls.length, 2);
	const [a, b] = calls.map((c) => decodeFunctionData({ abi, data: c.data }));
	assert.deepEqual(a?.args, [10n ** 17n, 0n]);
	assert.deepEqual(b?.args, [0n, 50_000_000n]);
	assert.equal(
		redeemCalls(
			position({
				holdings: {
					underlyingYes: 0n,
					underlyingNo: 0n,
					dollarYes: 0n,
					dollarNo: 1n,
				},
			}),
		).length,
		1,
	);
	assert.equal(holdsAny(position().holdings), true);
});

test("undo approves the share and the kept dollar, then exits with a floor and a deadline", () => {
	const calls = undoCalls({
		router,
		position: position(),
		recipient: holder,
		quotes: { yes: 60_000_000n },
		nowSeconds: 1_900n,
	});
	assert.equal(calls.length, 3);
	const exit = decodeFunctionData({ abi, data: calls[2]?.data ?? "0x" });
	assert.equal(exit.functionName, "exit");
	const order = (exit.args as unknown as [Record<string, unknown>])[0];
	assert.equal(order.yes, true);
	assert.equal(order.shares, 10n ** 17n);
	assert.equal(order.kept, 50_000_000n);
	assert.equal(order.minOut, 59_400_000n);
	assert.equal(order.deadline, 2_000n);
	assert.equal(order.level, 0n);
	assert.equal(undoDollars(position(), { yes: 60_000_000n }), 50_000_000n);
	assert.throws(() =>
		undoCalls({
			router,
			position: position(),
			recipient: holder,
			quotes: { yes: 1n },
			nowSeconds: 2_000n,
		}),
	);
});

test("amounts read to four decimals and pool ids are 32 bytes", () => {
	assert.equal(formatUnits4(123_456_789n, 6), "123.4567");
	assert.equal(formatUnits4(10n ** 18n, 18), "1");
	const id = poolIdOf({
		currency0: router,
		currency1: holder,
		fee: 3000,
		tickSpacing: 60,
		hooks: router,
	});
	assert.equal(id.length, 66);
});

const mixed = () =>
	position({
		holdings: {
			underlyingYes: 10n ** 17n,
			underlyingNo: 3n * 10n ** 16n,
			dollarYes: 20_000_000n,
			dollarNo: 50_000_000n,
		},
	});

test("a position that bought both worlds shows both, and undo exits both", () => {
	assert.deepEqual(
		sidesOf(mixed().holdings).map((s) => [s.yes, s.shares, s.kept]),
		[
			[true, 10n ** 17n, 50_000_000n],
			[false, 3n * 10n ** 16n, 20_000_000n],
		],
	);
	const calls = undoCalls({
		router,
		position: mixed(),
		recipient: holder,
		quotes: { yes: 60_000_000n, no: 15_000_000n },
		nowSeconds: 1_900n,
	});
	const exits = calls
		.map((c) => decodeFunctionData({ abi, data: c.data }))
		.filter((d) => d.functionName === "exit")
		.map((d) => (d.args as unknown as [Record<string, unknown>])[0]);
	assert.deepEqual(
		exits.map((o) => [o.yes, o.shares, o.kept]),
		[
			[true, 10n ** 17n, 50_000_000n],
			[false, 3n * 10n ** 16n, 20_000_000n],
		],
	);
	assert.equal(
		undoDollars(mixed(), { yes: 60_000_000n, no: 15_000_000n }),
		65_000_000n,
	);
});

test("dust left by an undo is not a position: under 0.0001 share and under a cent", () => {
	const dust = {
		underlyingYes: 10n ** 13n,
		underlyingNo: 0n,
		dollarYes: 0n,
		dollarNo: 9_999n,
	};
	assert.equal(holdsAny(dust), false);
	assert.deepEqual(sidesOf(dust), []);
	assert.equal(holdsAny({ ...dust, dollarNo: 110_000n }), true);
});

test("a world the pool will not quote is left out of the undo, and nothing to undo says so", () => {
	assert.equal(
		undoCalls({
			router,
			position: mixed(),
			recipient: holder,
			quotes: { yes: 60_000_000n },
			nowSeconds: 1_900n,
		}).filter((c) => c.to === router).length,
		1,
	);
	assert.throws(
		() =>
			undoCalls({
				router,
				position: mixed(),
				recipient: holder,
				quotes: {},
				nowSeconds: 1_900n,
			}),
		/nothing to undo/,
	);
});
