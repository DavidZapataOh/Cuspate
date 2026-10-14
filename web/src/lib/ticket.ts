/** The pools' fee, in basis points, paid on the dollars swapped for the condition's shares. */
export const POOL_FEE_BPS = 30n;

/**
 * What an amount buys, from sample prices: the dollars become the shares of the world bought, at
 * that world's price, less the pools' fee; in the other world the same dollars come back.
 */
export function preview({
	amountCents,
	yesPriceCents,
	noPriceCents = yesPriceCents,
	yes = true,
}: {
	amountCents: bigint;
	yesPriceCents: bigint;
	noPriceCents?: bigint;
	yes?: boolean;
}) {
	const feeCents = (amountCents * POOL_FEE_BPS) / 10_000n;
	const price = yes ? yesPriceCents : noPriceCents;
	const shares =
		amountCents > 0n && price > 0n
			? Number(amountCents - feeCents) / Number(price)
			: 0;
	return { feeCents, shares, backCents: amountCents };
}

/** Dollars as typed, in cents: digits, an optional comma separator and at most two decimals. */
export function parseAmount(text: string): bigint | undefined {
	const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(
		text.trim().replace(/,/g, ""),
	);
	if (!match) return undefined;
	return (
		BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"))
	);
}
