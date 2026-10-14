import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeErrorResult, parseAbi, UserRejectedRequestError } from "viem";
import { BANNED } from "../../src/lib/banned.ts";
import { problemOf, problemText } from "../../src/ticket/problems.ts";

const errors = parseAbi([
	"error Frozen(bytes32 id, uint64 instant)",
	"error CapExceeded(uint256 cap, uint256 outstanding, uint256 amount)",
	"error TooLittleOut(uint256 out, uint256 minimum)",
	"error Expired(uint256 deadline)",
	"error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
	"error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
	"error UnexpectedRevertBytes(bytes revertData)",
	"error NotEnoughLiquidity(bytes32 poolId)",
	"error PartialFill(uint256 consumed, uint256 amountIn)",
]);
const holder = "0x2222222222222222222222222222222222222222";
const instant = 1_792_612_800n; // 2026-10-21T20:00:00Z

test("a frozen market says when trading closed, even when the pool manager wraps the hook's refusal", () => {
	const frozen = encodeErrorResult({
		abi: errors,
		errorName: "Frozen",
		args: [`0x${"00".repeat(32)}`, instant],
	});
	assert.deepEqual(problemOf(frozen), { kind: "closed", at: 1_792_612_800 });
	const wrapped = encodeErrorResult({
		abi: errors,
		errorName: "WrappedError",
		args: [holder, "0x575e24b4", frozen, "0xa9e35b2f"],
	});
	assert.deepEqual(problemOf(wrapped), { kind: "closed", at: 1_792_612_800 });
	const quoted = encodeErrorResult({
		abi: errors,
		errorName: "UnexpectedRevertBytes",
		args: [wrapped],
	});
	assert.deepEqual(problemOf(quoted), { kind: "closed", at: 1_792_612_800 });
	assert.equal(
		problemText(problemOf(wrapped)),
		"Trading closed at Oct 21, 4:00 pm ET.",
	);
});

test("a full market says how much can still be bought", () => {
	const full = encodeErrorResult({
		abi: errors,
		errorName: "CapExceeded",
		args: [1_000_000_000n, 880_000_000n, 500_000_000n],
	});
	assert.deepEqual(problemOf(full), { kind: "full", roomCents: 12_000n });
	assert.equal(
		problemText(problemOf(full)),
		"This market is full. You can buy up to $120.00.",
	);
});

test("too few test dollars says how many more, and that nothing was charged", () => {
	const short = encodeErrorResult({
		abi: errors,
		errorName: "ERC20InsufficientBalance",
		args: [holder, 200_000_000n, 500_000_000n],
	});
	assert.deepEqual(problemOf(short), { kind: "short", needCents: 30_000n });
	assert.equal(
		problemText(problemOf(short)),
		"You need $300.00 more. Nothing was charged.",
	);
});

test("a moved price and an expired order ask to try again; anything else fails plainly", () => {
	const moved = encodeErrorResult({
		abi: errors,
		errorName: "TooLittleOut",
		args: [1n, 2n],
	});
	assert.deepEqual(problemOf(moved), { kind: "moved" });
	const late = encodeErrorResult({
		abi: errors,
		errorName: "Expired",
		args: [1n],
	});
	assert.deepEqual(problemOf(late), { kind: "moved" });
	assert.deepEqual(problemOf("0x"), { kind: "failed" });
	assert.deepEqual(problemOf(undefined), { kind: "failed" });
	assert.equal(
		problemText({ kind: "failed" }),
		"That didn't go through, and nothing moved. Try again.",
	);
});

test("no problem's words use the vocabulary the product avoids", () => {
	for (const problem of [
		{ kind: "closed", at: 1_792_612_800 },
		{ kind: "full", roomCents: 100n },
		{ kind: "short", needCents: 100n },
		{ kind: "moved" },
		{ kind: "failed" },
	] as const) {
		const text = problemText(problem);
		for (const word of BANNED)
			assert.doesNotMatch(text, new RegExp(`\\b${word}\\b`, "i"));
	}
});

test("a pool that cannot take the whole amount says how much it takes, rounded down", () => {
	const partial = encodeErrorResult({
		abi: errors,
		errorName: "PartialFill",
		args: [10_812_345_678n, 20_000_000_000n],
	});
	assert.deepEqual(problemOf(partial), { kind: "depth", maxCents: 1_081_234n });
	assert.equal(
		problemText(problemOf(partial)),
		"At most $10,812.34 can be bought right now.",
	);
	const quoted = encodeErrorResult({
		abi: errors,
		errorName: "UnexpectedRevertBytes",
		args: [
			encodeErrorResult({
				abi: errors,
				errorName: "NotEnoughLiquidity",
				args: [`0x${"11".repeat(32)}`],
			}),
		],
	});
	assert.deepEqual(problemOf(quoted), { kind: "depth" });
});

test("a declined signature is named as the buyer's own choice", () => {
	const declined = new UserRejectedRequestError(new Error("User rejected"));
	assert.deepEqual(problemOf(undefined, declined), { kind: "cancelled" });
	assert.equal(
		problemText({ kind: "cancelled" }),
		"You cancelled the signature.",
	);
	assert.deepEqual(problemOf(undefined, { code: 4001 }), { kind: "cancelled" });
	assert.deepEqual(problemOf(undefined, new Error("other")), {
		kind: "failed",
	});
});

test("a purchase that met a moved price says nothing was charged", () => {
	assert.equal(
		problemText({ kind: "moved" }),
		"The price moved before your purchase landed; nothing was charged.",
	);
});
