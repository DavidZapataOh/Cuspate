/**
 * Why a purchase would not go through, read from the chain's refusal and said in plain words. A
 * refusal from inside a pool reaches the caller wrapped by the pool manager; it is unwrapped first.
 */
import {
	BaseError,
	decodeErrorResult,
	type Hex,
	parseAbi,
	UserRejectedRequestError,
} from "viem";
import { formatUsd } from "../lib/format.ts";
import { announcementEt } from "../lib/time.ts";

/** A reason a purchase cannot go through, with what the buyer needs to know. */
export type Problem =
	| { kind: "closed"; at: number }
	| { kind: "full"; roomCents: bigint }
	| { kind: "short"; needCents: bigint }
	| { kind: "moved" }
	/** The pool cannot take that much now; at most `maxCents`, when it is known. */
	| { kind: "depth"; maxCents?: bigint }
	| { kind: "cancelled" }
	| { kind: "failed" };

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

/** Six-decimal dollar units as cents, rounded up so a shortfall is never understated. */
function unitsToCentsUp(units: bigint): bigint {
	return (units + 9_999n) / 10_000n;
}

/** Whether an error is the wallet's holder declining to sign. */
function declined(error: unknown): boolean {
	if (error instanceof BaseError)
		return (
			error.walk(
				(e) =>
					e instanceof UserRejectedRequestError ||
					(e as { code?: unknown }).code === 4001,
			) !== null
		);
	return (error as { code?: unknown } | undefined)?.code === 4001;
}

/**
 * The problem a refusal names; anything unrecognised is a plain failure.
 * @param error The error the refusal came in, when there is one: a declined signature is named so.
 */
export function problemOf(data: Hex | undefined, error?: unknown): Problem {
	if (error !== undefined && declined(error)) return { kind: "cancelled" };
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
		case "NotEnoughLiquidity":
			return { kind: "depth" };
		case "PartialFill":
			// Rounded down: the size stated is a size the pool really takes.
			return { kind: "depth", maxCents: decoded.args[0] / 10_000n };
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
			return "The price moved before your purchase landed; nothing was charged.";
		case "depth":
			return problem.maxCents !== undefined
				? `At most ${formatUsd(problem.maxCents)} can be bought right now.`
				: "The pool cannot fill that much right now. Try a smaller amount.";
		case "cancelled":
			return "You cancelled the signature.";
		case "failed":
			return "That didn't go through, and nothing moved. Try again.";
	}
}
