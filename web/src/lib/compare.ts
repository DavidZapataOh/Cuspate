import { POOL_FEE_BPS } from "./ticket.ts";

/** What the same dollars hold after the announcement, three ways, in cents and shares. */
export type Outcomes = {
	/** Shares bought outright today, held whatever is reported. */
	stockShares: number;
	/** Shares held if the condition is met; otherwise the dollars come back. */
	conditionalShares: number;
	/** The pools' fee paid on the conditional purchase, in cents. */
	feeCents: number;
	/** The value of each holding at the price the visitor names, in cents. */
	stockValueCents: number;
	metValueCents: number;
	notMetValueCents: number;
	/** With a call option the visitor prices: how many shares it covers and what it is worth. */
	callShares?: number;
	callValueCents?: number;
};

/**
 * The same amount put three ways: into the stock today at the feed's price, into the condition at
 * the price of a share in the world where it is met (less the pools' fee), and, when the visitor
 * brings one, into call options at their premium and strike. Values are taken at the stock price the
 * visitor names for after the announcement. Nothing here is a quote from an exchange.
 */
export function outcomes({
	amountCents,
	spotCents,
	metWorldPriceCents,
	afterCents,
	premiumCents,
	strikeCents,
}: {
	amountCents: bigint;
	spotCents: bigint;
	metWorldPriceCents: bigint;
	afterCents: bigint;
	premiumCents?: bigint;
	strikeCents?: bigint;
}): Outcomes {
	const amount = Number(amountCents);
	const after = Number(afterCents);
	const fee = Number((amountCents * POOL_FEE_BPS) / 10_000n);
	const stockShares = spotCents > 0n ? amount / Number(spotCents) : 0;
	const conditionalShares =
		metWorldPriceCents > 0n ? (amount - fee) / Number(metWorldPriceCents) : 0;
	const result: Outcomes = {
		stockShares,
		conditionalShares,
		feeCents: fee,
		stockValueCents: stockShares * after,
		metValueCents: conditionalShares * after,
		notMetValueCents: amount,
	};
	if (
		premiumCents !== undefined &&
		premiumCents > 0n &&
		strikeCents !== undefined
	) {
		const callShares = amount / Number(premiumCents);
		result.callShares = callShares;
		result.callValueCents =
			callShares * Math.max(after - Number(strikeCents), 0);
	}
	return result;
}

/** A whole number of cents from a fractional one, for display. */
export function roundCents(cents: number): bigint {
	return BigInt(Math.round(cents));
}
