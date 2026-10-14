/** The pools' fee, in basis points, paid on the dollars swapped for the condition's shares. */
export const POOL_FEE_BPS = 30n;

/**
 * What an amount buys at the pools' current prices, before the quoter answers: the dollars become the shares of the world bought, at
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

/** The most one amount can be: nine digits of dollars. */
export const MAX_AMOUNT_DIGITS = 9;

const AMOUNT = /^(?=\.?\d)(\d{0,9})(?:\.(\d{0,2}))?$/;

/**
 * Dollars as typed, in cents: digits, an optional comma separator and at most two decimals; "500."
 * and ".5" read as 500 and 0.50.
 */
export function parseAmount(text: string): bigint | undefined {
	const match = AMOUNT.exec(text.trim().replace(/,/g, ""));
	if (!match) return undefined;
	return (
		BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"))
	);
}

/** Why typed text is not an amount, in words; nothing when it is one or is empty. */
export function amountProblem(text: string): string | undefined {
	const typed = text.trim().replace(/,/g, "");
	if (typed === "" || parseAmount(typed) !== undefined) return undefined;
	const whole = typed.split(".")[0] ?? "";
	if (/^\d+$/.test(whole) && whole.length > MAX_AMOUNT_DIGITS)
		return "The most one ticket takes is $999,999,999.99.";
	return "Enter dollars and cents, like 500 or 12.50.";
}

/** The fewest shares a ticket buys: 0.0001 share, the smallest amount it shows. */
export const MIN_SHARES = 10n ** 14n;

/**
 * The smallest amount, in cents, that buys at least `MIN_SHARES` at a share price in cents, the
 * pools' fee included, rounded up to the cent.
 */
export function minimumCents(priceCents: bigint): bigint {
	const before = (priceCents + 9_999n) / 10_000n;
	return (
		(before * 10_000n + (10_000n - POOL_FEE_BPS) - 1n) /
		(10_000n - POOL_FEE_BPS)
	);
}
