/**
 * A purchase as calls: the approval it needs, then the router's entry, with the floor and the
 * deadline that protect the buyer. Pure, so every number on the ticket can be checked without a
 * chain.
 */
import { type Address, encodeFunctionData, type Hex, parseAbi } from "viem";

/** How far below the quote a purchase may fill: one percent, in basis points. */
export const SLIPPAGE_BPS = 100n;

/** How long a signed purchase stays valid, in seconds. */
export const DEADLINE_SECONDS = 600n;

/** The pools' fee, in millionths of the amount sold: 0.30%. */
export const POOL_FEE_PPM = 3_000n;

/** One call of a batch, as a wallet sends it. */
export type Call = { to: Address; data: Hex; value: bigint };

const abi = parseAbi([
	"function approve(address spender, uint256 amount) returns (bool)",
	"function enter(bytes32 marketId, bool yes, uint256 dollars, uint256 minShares, address recipient, uint256 deadline) returns (uint256 shares)",
]);

/** Cents as the test dollar's own units, which have six decimals. */
export function centsToDollarUnits(cents: bigint): bigint {
	return cents * 10_000n;
}

/**
 * The fewest shares a purchase accepts: the quote less the slippage allowed, and never zero, which
 * the router refuses.
 * @throws for a quote of nothing.
 */
export function floorOf(quotedShares: bigint): bigint {
	if (quotedShares <= 0n) throw new Error("a quote of nothing has no floor");
	const floor = (quotedShares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
	return floor > 0n ? floor : 1n;
}

/**
 * The latest instant a purchase may run at: the deadline window from now, cut at the freeze.
 * @throws when trading has already closed.
 */
export function deadlineFor(nowSeconds: bigint, freezesAt: bigint): bigint {
	if (nowSeconds >= freezesAt) throw new Error("trading has closed");
	const latest = nowSeconds + DEADLINE_SECONDS;
	return latest < freezesAt ? latest : freezesAt;
}

/** The pools' fee on an amount in cents, rounded up to the cent, as the ticket shows it. */
export function feeCents(amountCents: bigint): bigint {
	return (amountCents * POOL_FEE_PPM + 999_999n) / 1_000_000n;
}

/** The calls of a purchase: an approval of exactly the amount when the allowance falls short, then the entry. */
export function entryCalls(order: {
	router: Address;
	dollar: Address;
	marketId: Hex;
	yes: boolean;
	dollars: bigint;
	minShares: bigint;
	recipient: Address;
	deadline: bigint;
	allowance: bigint;
}): Call[] {
	const enter: Call = {
		to: order.router,
		value: 0n,
		data: encodeFunctionData({
			abi,
			functionName: "enter",
			args: [
				order.marketId,
				order.yes,
				order.dollars,
				order.minShares,
				order.recipient,
				order.deadline,
			],
		}),
	};
	if (order.allowance >= order.dollars) return [enter];
	const approve: Call = {
		to: order.dollar,
		value: 0n,
		data: encodeFunctionData({
			abi,
			functionName: "approve",
			args: [order.router, order.dollars],
		}),
	};
	return [approve, enter];
}
