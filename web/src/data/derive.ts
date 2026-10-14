/**
 * Pure arithmetic over what the chain holds, so every number the screens show is computed the same
 * way the contracts compute it and can be checked in isolation: the chance a market's probability
 * pool implies, each world's share price, the two pans of the balance, and amounts in cents.
 */

/** One in the pool manager's Q64.96 format. */
const Q96 = 1n << 96n;

/** One dollar at 18 decimals: the unit a yes-dollar's price is written in. */
export const ONE = 10n ** 18n;

/**
 * The yes-dollar's price in dollars at a sqrt price of a market's probability pool: the implied
 * probability of yes, counting invalid as half, 18-decimal. Rounded down in both currency orders,
 * exactly as the protocol's own reading is, so it never overstates.
 * @param yesFirst Whether the yes-dollar is the pool's first currency.
 */
export function yesDollarPrice(
	sqrtPriceX96: bigint,
	yesFirst: boolean,
): bigint {
	if (yesFirst) {
		const price = (sqrtPriceX96 * sqrtPriceX96) / Q96;
		return (price * ONE) / (price + Q96);
	}
	const product = sqrtPriceX96 * sqrtPriceX96;
	const inverse = product / Q96 + (product % Q96 === 0n ? 0n : 1n);
	return (Q96 * ONE) / (inverse + Q96);
}

/** An 18-decimal price of a yes-dollar as a chance between 0 and 1. */
export function chanceOf(yesDollar: bigint): number {
	return Number(yesDollar) / Number(ONE);
}

/**
 * What one whole share costs in a world, in cents of that world's dollar, at a sqrt price of the
 * world's pool. The pool prices its second currency in raw units per raw unit of its first, so both
 * tokens' decimals apply, and the price inverts when the share is the second currency. Rounded to
 * the nearest cent.
 */
export function worldPriceCents(
	sqrtPriceX96: bigint,
	shareIsToken0: boolean,
	shareDecimals: number,
	dollarDecimals: number,
): bigint {
	const squared = sqrtPriceX96 * sqrtPriceX96;
	const q192 = Q96 * Q96;
	const shareUnit = 10n ** BigInt(shareDecimals);
	const dollarUnit = 10n ** BigInt(dollarDecimals);
	// Dollars per share = raw dollars per raw share * shareUnit / dollarUnit; in cents, times 100.
	const [num, den] = shareIsToken0
		? [squared * shareUnit * 100n, q192 * dollarUnit]
		: [q192 * shareUnit * 100n, squared * dollarUnit];
	if (den === 0n) return 0n;
	return (num + den / 2n) / den;
}

/**
 * The two pans of the balance: a share in the yes world bought with yes-dollars, each worth the
 * yes-dollar's price, and a share in the no world bought with no-dollars, each worth the rest of a
 * dollar. Their sum is the share price the pools imply.
 */
export function pans(
	yesWorldCents: bigint,
	noWorldCents: bigint,
	yesDollar: bigint,
): { beat: bigint; dont: bigint; implied: bigint } {
	const half = ONE / 2n;
	const beat = (yesWorldCents * yesDollar + half) / ONE;
	const dont = (noWorldCents * (ONE - yesDollar) + half) / ONE;
	return { beat, dont, implied: beat + dont };
}

/** An amount in a token's raw units as cents of a dollar, rounded down. */
export function centsOf(amount: bigint, decimals: number): bigint {
	return decimals >= 2
		? amount / 10n ** BigInt(decimals - 2)
		: amount * 10n ** BigInt(2 - decimals);
}

/** A fee in hundredths of a basis point, as the pool manager holds it, in basis points. */
export function feeBpsOf(pips: number): bigint {
	return BigInt(pips) / 100n;
}
