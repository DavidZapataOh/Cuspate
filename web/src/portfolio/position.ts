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

/** Below these a leg is dust: less than 0.0001 share, or less than a cent of dollars. */
export const DUST_SHARES = 10n ** 14n;
export const DUST_DOLLARS = 10_000n;

/**
 * Which world a position is in: the world whose share of the stock it holds more of. A position can
 * hold both (`sidesOf` lists each); this names the larger, for a single label.
 */
export function worldOf(h: Holdings): boolean {
	return h.underlyingYes >= h.underlyingNo;
}

/** One world a position holds: its share of the stock and the other world's dollar kept beside it. */
export type Side = { yes: boolean; shares: bigint; kept: bigint };

/**
 * Every world a position holds more than dust in: buying the yes world leaves its share and the no
 * world's dollar, buying the no world the reverse, and a holder who bought both holds both.
 */
export function sidesOf(h: Holdings): Side[] {
	const sides: Side[] = [];
	if (h.underlyingYes >= DUST_SHARES || h.dollarNo >= DUST_DOLLARS)
		sides.push({ yes: true, shares: h.underlyingYes, kept: h.dollarNo });
	if (h.underlyingNo >= DUST_SHARES || h.dollarYes >= DUST_DOLLARS)
		sides.push({ yes: false, shares: h.underlyingNo, kept: h.dollarYes });
	return sides;
}

/** Whether an address holds more than dust in a market. */
export function holdsAny(h: Holdings): boolean {
	return sidesOf(h).length > 0;
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
 * The calls that undo a position before the freeze, one exit for each world it holds a share in:
 * approve the router for the share and the other world's dollar, then exit. The share is sold for its
 * world's dollar, which merges with the kept dollar into plain dollars; whatever does not pair comes
 * back as that world's dollar. A world whose share has no quote (dust a pool will not buy) is left.
 * @throws when no world can be undone or trading has closed.
 */
export function undoCalls(order: {
	router: Address;
	position: Position;
	recipient: Address;
	/** What each world's shares sell for now, in that world's dollar. */
	quotes: { yes?: bigint; no?: bigint };
	nowSeconds: bigint;
}): Call[] {
	const { position, router, recipient } = order;
	const freezesAt = BigInt(position.freezesAt);
	if (order.nowSeconds >= freezesAt) throw new Error("trading has closed");
	const latest = order.nowSeconds + UNDO_DEADLINE_SECONDS;
	const deadline = latest < freezesAt ? latest : freezesAt;
	const approve = (token: Address, amount: bigint): Call => ({
		to: token,
		data: encodeFunctionData({
			abi,
			functionName: "approve",
			args: [router, amount],
		}),
		value: 0n,
	});
	const calls: Call[] = [];
	for (const side of sidesOf(position.holdings)) {
		const quoted = side.yes ? order.quotes.yes : order.quotes.no;
		if (side.shares === 0n || quoted === undefined || quoted <= 0n) continue;
		const floor = (quoted * (10_000n - UNDO_SLIPPAGE_BPS)) / 10_000n;
		const share = side.yes
			? position.legs.underlyingYes
			: position.legs.underlyingNo;
		const keptToken = side.yes
			? position.legs.dollarNo
			: position.legs.dollarYes;
		calls.push(approve(share, side.shares));
		if (side.kept > 0n) calls.push(approve(keptToken, side.kept));
		calls.push({
			to: router,
			data: encodeFunctionData({
				abi,
				functionName: "exit",
				args: [
					{
						marketId: position.marketId,
						yes: side.yes,
						shares: side.shares,
						kept: side.kept,
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
	}
	if (calls.length === 0) throw new Error("nothing to undo");
	return calls;
}

/**
 * What an undo returns, in the dollar's units: for each world undone, the smaller of the two dollar
 * legs its exit ends with.
 */
export function undoDollars(
	position: Position,
	quotes: { yes?: bigint; no?: bigint },
): bigint {
	return sidesOf(position.holdings).reduce((sum, side) => {
		const quoted = side.yes ? quotes.yes : quotes.no;
		if (quoted === undefined) return sum;
		return sum + (quoted < side.kept ? quoted : side.kept);
	}, 0n);
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
