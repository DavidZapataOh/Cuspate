import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, parseAbi } from "viem";
import {
	centsToDollarUnits,
	DEADLINE_SECONDS,
	deadlineFor,
	entryCalls,
	feeCents,
	floorOf,
} from "../../src/ticket/order.ts";

const router = "0x80b38767D951170723291faC506348EFF7935a35";
const dollar = "0x1111111111111111111111111111111111111111";
const holder = "0x2222222222222222222222222222222222222222";
const marketId = `0x${"ab".repeat(32)}` as const;
const abi = parseAbi([
	"function approve(address spender, uint256 amount) returns (bool)",
	"function enter(bytes32 marketId, bool yes, uint256 dollars, uint256 minShares, address recipient, uint256 deadline) returns (uint256)",
]);

test("cents become the test dollar's six-decimal units", () => {
	assert.equal(centsToDollarUnits(50_000n), 500_000_000n);
	assert.equal(centsToDollarUnits(1n), 10_000n);
});

test("the floor accepts at most one percent less than the quote, and is never zero", () => {
	assert.equal(floorOf(10_000n), 9_900n);
	assert.equal(floorOf(1n), 1n);
	assert.throws(() => floorOf(0n));
});

test("the deadline is ten minutes away, but never past the freeze", () => {
	const now = 1_000_000n;
	assert.equal(DEADLINE_SECONDS, 600n);
	assert.equal(deadlineFor(now, now + 3_600n), now + 600n);
	assert.equal(deadlineFor(now, now + 60n), now + 60n);
	assert.throws(() => deadlineFor(now, now), /closed/);
});

test("the fee is the pools' 0.30% on the dollars sold, rounded up to the cent", () => {
	assert.equal(feeCents(50_000n), 150n);
	assert.equal(feeCents(100n), 1n);
	assert.equal(feeCents(1n), 1n);
});

test("a purchase is the approval it needs, exactly the amount, then the entry", () => {
	const args = {
		router,
		dollar,
		marketId,
		yes: true,
		dollars: 500_000_000n,
		minShares: 9_900n,
		recipient: holder,
		deadline: 1_000_600n,
	} as const;
	const calls = entryCalls({ ...args, allowance: 0n });
	assert.equal(calls.length, 2);
	assert.equal(calls[0]?.to, dollar);
	assert.deepEqual(
		decodeFunctionData({ abi, data: calls[0]?.data ?? "0x" }).args,
		[router, 500_000_000n],
	);
	assert.equal(calls[1]?.to, router);
	assert.deepEqual(decodeFunctionData({ abi, data: calls[1]?.data ?? "0x" }), {
		functionName: "enter",
		args: [marketId, true, 500_000_000n, 9_900n, holder, 1_000_600n],
	});
	for (const call of calls) assert.equal(call.value, 0n);
	const enough = entryCalls({ ...args, allowance: 500_000_000n });
	assert.equal(enough.length, 1);
	assert.equal(enough[0]?.to, router);
});
