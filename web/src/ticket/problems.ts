/**
 * Why a purchase would not go through, read from the chain's refusal and said in plain words. A
 * refusal from inside a pool reaches the caller wrapped by the pool manager; it is unwrapped first.
 */
import { decodeErrorResult, type Hex, parseAbi } from "viem";
import { formatUsd } from "../lib/format.ts";
import { announcementEt } from "../lib/time.ts";

/** A reason a purchase cannot go through, with what the buyer needs to know. */
export type Problem =
	| { kind: "closed"; at: number }
	| { kind: "full"; roomCents: bigint }
	| { kind: "short"; needCents: bigint }
	| { kind: "moved" }
	| { kind: "failed" };

const errors = parseAbi([
	"error Frozen(bytes32 id, uint64 instant)",
	"error CapExceeded(uint256 cap, uint256 outstanding, uint256 amount)",
	"error TooLittleOut(uint256 out, uint256 minimum)",
	"error Expired(uint256 deadline)",
	"error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
	"error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
	"error UnexpectedRevertBytes(bytes revertData)",
]);

/** Six-decimal dollar units as cents, rounded up so a shortfall is never understated. */
function unitsToCentsUp(units: bigint): bigint {
	return (units + 9_999n) / 10_000n;
}

/** The problem a refusal names; anything unrecognised is a plain failure. */
export function problemOf(data: Hex | undefined): Problem {
	if (!data || data === "0x") return { kind: "failed" };
	let decoded: ReturnType<typeof decodeErrorResult<typeof errors>>;
	try {
		decoded = decodeErrorResult({ abi: errors, data });
	} catch {
		return { kind: "failed" };
	}
	switch (decoded.errorName) {
		case "WrappedError":
			return problemOf(decoded.args[2]);
		case "UnexpectedRevertBytes":
			return problemOf(decoded.args[0]);
		case "Frozen":
			return { kind: "closed", at: Number(decoded.args[1]) };
		case "CapExceeded": {
			const [cap, outstanding] = decoded.args;
			// Rounded down: the room stated is room that is really there.
			return { kind: "full", roomCents: (cap - outstanding) / 10_000n };
		}
		case "ERC20InsufficientBalance": {
			const [, balance, needed] = decoded.args;
			return { kind: "short", needCents: unitsToCentsUp(needed - balance) };
		}
		case "TooLittleOut":
		case "Expired":
			return { kind: "moved" };
	}
}

/** What the ticket says about a problem. */
export function problemText(problem: Problem): string {
	switch (problem.kind) {
		case "closed":
			return `Trading closed at ${announcementEt(new Date(problem.at * 1000).toISOString())}.`;
		case "full":
			return `This market is full. You can buy up to ${formatUsd(problem.roomCents)}.`;
		case "short":
			return `You need ${formatUsd(problem.needCents)} more. Nothing was charged.`;
		case "moved":
			return "The price changed before your order went through. Nothing was charged. Try again.";
		case "failed":
			return "That didn't go through, and nothing moved. Try again.";
	}
}
