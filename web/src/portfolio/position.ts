/**
 * A position as the portfolio shows it, and what can be done with it, as calls. Pure, so every
 * phase, payout and call can be checked without a chain.
 *
 * Entering a market leaves the holder two tokens: one world's share of the stock, and the other
 * world's dollar. Before the announcement the router can sell the share back and merge the dollars
 * (undo); after the outcome is reported each vault exchanges its legs for what they pay (redeem).
 */
import { type Address, encodeFunctionData, type Hex, parseAbi } from "viem";
import type { Call } from "../ticket/order.ts";

/** The outcome a vault reads, in the order the contracts number it. */
export type Outcome = "unresolved" | "yes" | "no" | "invalid";

/** Outcomes by the number the contracts return. */
export const OUTCOMES: readonly Outcome[] = [
	"unresolved",
	"yes",
	"no",
	"invalid",
];

/** One market's legs as held by one address, in each token's own units. */
export type Holdings = {
	underlyingYes: bigint;
	underlyingNo: bigint;
	dollarYes: bigint;
	dollarNo: bigint;
};

/** Where a position stands: tradeable, frozen awaiting the figure, or settled. */
export type Phase = "open" | "frozen" | "settled";

/** One market's position for one address, with everything the screen and its actions need. */
export type Position = {
	eventKey: string;
	conditionKey: string;
	issuer: string;
	/** The address holding it. */
	holder: Address;
	marketId: Hex;
	underlyingVault: Address;
	dollarVault: Address;
	legs: {
		underlyingYes: Address;
		underlyingNo: Address;
		dollarYes: Address;
		dollarNo: Address;
	};
	holdings: Holdings;
	/** When trading freezes, in seconds; zero when the pools are not registered. */
	freezesAt: number;
	outcome: Outcome;
};

/** Which world a position is in: the world whose share of the stock it holds more of. */
export function worldOf(h: Holdings): boolean {
	return h.underlyingYes >= h.underlyingNo;
}

/** Whether an address holds anything in a market. */
export function holdsAny(h: Holdings): boolean {
	return (
		h.underlyingYes > 0n ||
		h.underlyingNo > 0n ||
		h.dollarYes > 0n ||
		h.dollarNo > 0n
	);
}

/** The phase of a position at a moment, in seconds. */
export function phaseOf(
	position: Pick<Position, "freezesAt" | "outcome">,
	nowSeconds: number,
): Phase {
	if (position.outcome !== "unresolved") return "settled";
	if (position.freezesAt > 0 && nowSeconds < position.freezesAt) return "open";
	return "frozen";
}

/**
 * What one vault pays for legs once its outcome is reported: the winning leg one for one, the
 * losing leg nothing, each leg half on an invalid outcome. The same formula as the vault, rounded
 * down once over the sum.
 */
export function payoutOf(outcome: Outcome, yes: bigint, no: bigint): bigint {
	if (outcome === "unresolved") return 0n;
	const [wy, wn] =
		outcome === "yes" ? [2n, 0n] : outcome === "no" ? [0n, 2n] : [1n, 1n];
	return (yes * wy + no * wn) / 2n;
}

/** What redeeming a whole position pays: shares of the stock, and dollars, in their own units. */
export function settlementOf(position: Position): {
	shares: bigint;
	dollars: bigint;
} {
	const h = position.holdings;
	return {
		shares: payoutOf(position.outcome, h.underlyingYes, h.underlyingNo),
		dollars: payoutOf(position.outcome, h.dollarYes, h.dollarNo),
	};
}

const abi = parseAbi([
	"function approve(address spender, uint256 amount) returns (bool)",
	"function redeemPositions(uint256 yesAmount, uint256 noAmount)",
	"function exit((bytes32 marketId, bool yes, uint256 shares, uint256 kept, uint256 minOut, bool levelSellsWorldDollar, uint256 level, uint256 minLevelOut, address recipient, uint256 deadline) order) returns (uint256 dollars)",
]);

/**
 * The calls that redeem every leg held, vault by vault, skipping a vault where nothing is held. A
 * losing leg is redeemed too, so the position leaves the portfolio.
 */
export function redeemCalls(position: Position): Call[] {
	const h = position.holdings;
	const calls: Call[] = [];
	const add = (vault: Address, yes: bigint, no: bigint) => {
		if (yes === 0n && no === 0n) return;
		calls.push({
			to: vault,
			data: encodeFunctionData({
				abi,
				functionName: "redeemPositions",
				args: [yes, no],
			}),
			value: 0n,
		});
	};
	add(position.underlyingVault, h.underlyingYes, h.underlyingNo);
	add(position.dollarVault, h.dollarYes, h.dollarNo);
	return calls;
}

/** How far below the quote an undo may fill: one percent, in basis points. */
export const UNDO_SLIPPAGE_BPS = 100n;

/** How long a signed undo stays valid, in seconds, cut at the freeze. */
export const UNDO_DEADLINE_SECONDS = 600n;

/**
 * The calls that undo a position before the freeze: approve the router for the share and the other
 * world's dollar, then exit. The share is sold for its world's dollar, which merges with the kept
 * dollar into plain dollars; whatever does not pair comes back as that world's dollar.
 * @throws when the position holds no share, the quote is nothing, or trading has closed.
 */
export function undoCalls(order: {
	router: Address;
	position: Position;
	recipient: Address;
	/** What the shares sell for now, in the world's dollar. */
	quotedOut: bigint;
	nowSeconds: bigint;
}): Call[] {
	const { position, router, recipient } = order;
	const yes = worldOf(position.holdings);
	const shares = yes
		? position.holdings.underlyingYes
		: position.holdings.underlyingNo;
	const kept = yes ? position.holdings.dollarNo : position.holdings.dollarYes;
	if (shares === 0n) throw new Error("no share to sell");
	if (order.quotedOut <= 0n) throw new Error("a quote of nothing has no floor");
	const freezesAt = BigInt(position.freezesAt);
	if (order.nowSeconds >= freezesAt) throw new Error("trading has closed");
	const latest = order.nowSeconds + UNDO_DEADLINE_SECONDS;
	const deadline = latest < freezesAt ? latest : freezesAt;
	const floor = (order.quotedOut * (10_000n - UNDO_SLIPPAGE_BPS)) / 10_000n;
	const share = yes ? position.legs.underlyingYes : position.legs.underlyingNo;
	const keptToken = yes ? position.legs.dollarNo : position.legs.dollarYes;
	const approve = (token: Address, amount: bigint): Call => ({
		to: token,
		data: encodeFunctionData({
			abi,
			functionName: "approve",
			args: [router, amount],
		}),
		value: 0n,
	});
	const calls = [approve(share, shares)];
	if (kept > 0n) calls.push(approve(keptToken, kept));
	calls.push({
		to: router,
		data: encodeFunctionData({
			abi,
			functionName: "exit",
			args: [
				{
					marketId: position.marketId,
					yes,
					shares,
					kept,
					minOut: floor > 0n ? floor : 1n,
					levelSellsWorldDollar: false,
					level: 0n,
					minLevelOut: 0n,
					recipient,
					deadline,
				},
			],
		}),
		value: 0n,
	});
	return calls;
}

/** What an undo returns, in the dollar's units: the smaller of the two dollar legs it ends with. */
export function undoDollars(position: Position, quotedOut: bigint): bigint {
	const yes = worldOf(position.holdings);
	const kept = yes ? position.holdings.dollarNo : position.holdings.dollarYes;
	return quotedOut < kept ? quotedOut : kept;
}

/** An amount in a token's units at most four decimals, without trailing zeros: "0.0418". */
export function formatUnits4(amount: bigint, decimals: number): string {
	const scale = 10n ** BigInt(decimals);
	const whole = amount / scale;
	const rest = amount % scale;
	const fraction = ((rest * 10_000n) / scale)
		.toString()
		.padStart(4, "0")
		.replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** The dollar's units (six decimals) as cents, rounded down. */
export function dollarUnitsToCents(units: bigint): bigint {
	return units / 10_000n;
}
