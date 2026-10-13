/**
 * The keeper's arithmetic: the prices the pools imply, the band around the feed's quote, and when the
 * keeper stays still. A port of the reference keeper the contracts' fork tests prove, checked against
 * its literal vectors; every division rounds exactly as the reference's does.
 */

const Q96 = 1n << 96n;
const ONE = 10n ** 18n;

/** How far outside the feed's quote the implied price may drift before the keeper corrects it. */
export const BAND = 10n ** 16n;

/** The oldest feed round the keeper acts on, from its publication, in seconds: about 2.5 heartbeats. */
export const MAX_AGE = 1500n;

const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const mulDivUp = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;

/** The floor of the square root. */
export function sqrt(value: bigint): bigint {
	if (value < 2n) return value;
	let x = value;
	let y = (x + 1n) / 2n;
	while (y < x) {
		x = y;
		y = (x + value / x) / 2n;
	}
	return x;
}

/** The floor of the square root of num / den in Q64.96, as the protocol's library takes it. */
function sqrtOf(num: bigint, den: bigint): bigint {
	return num / den < 1n << 64n
		? sqrt(mulDiv(num, 1n << 192n, den))
		: sqrt(mulDiv(num, 1n << 128n, den)) << 32n;
}

/**
 * A pool's opening sqrt price for a base token's price in the other, as the protocol's library sets it.
 * @param p.price The price, scaled by `10 ** priceDecimals`.
 * @param p.baseIsFirst Whether the base token is the pool's first currency.
 */
export function sqrtPriceX96(p: {
	price: bigint;
	priceDecimals: number;
	baseIsFirst: boolean;
	decimals0: number;
	decimals1: number;
}): bigint {
	const scaled =
		p.price * 10n ** BigInt(p.baseIsFirst ? p.decimals1 : p.decimals0);
	const unit =
		10n **
		BigInt(p.priceDecimals + (p.baseIsFirst ? p.decimals0 : p.decimals1));
	return p.baseIsFirst ? sqrtOf(scaled, unit) : sqrtOf(unit, scaled);
}

/** The probability pool's opening sqrt price for a yes-dollar price, 18 decimals. */
export function sqrtPriceAtYesDollarPrice(
	price: bigint,
	yesFirst: boolean,
): bigint {
	return yesFirst ? sqrtOf(price, ONE - price) : sqrtOf(ONE - price, price);
}

/**
 * A world pool's price in whole world dollars per whole share, 18 decimals. Shares have 18 decimals and
 * dollars 6, so a raw price r is r * 1e12 whole, 1e30 * r at 18 decimals; with the share second, the
 * raw price is inverted.
 */
export function worldPrice(sqrtPrice: bigint, shareIsFirst: boolean): bigint {
	if (shareIsFirst)
		return mulDiv(mulDiv(sqrtPrice, sqrtPrice, Q96), 10n ** 30n, Q96);
	return mulDiv(mulDiv(10n ** 30n, Q96, sqrtPrice), Q96, sqrtPrice);
}

/** The yes-dollar's price in dollars, 18 decimals: rounded down, its inverse rounded up when second. */
export function probability(
	sqrtPrice: bigint,
	yesDollarIsFirst: boolean,
): bigint {
	if (yesDollarIsFirst) {
		const price = mulDiv(sqrtPrice, sqrtPrice, Q96);
		return mulDiv(price, ONE, price + Q96);
	}
	const inverse = mulDivUp(sqrtPrice, sqrtPrice, Q96);
	return mulDiv(Q96, ONE, inverse + Q96);
}

/** The price the pools imply for one share, p * V_yes + (1 - p) * V_no, 18 decimals. */
export function impliedPrice(
	p: bigint,
	yesWorld: bigint,
	noWorld: bigint,
): bigint {
	return (p * yesWorld + (ONE - p) * noWorld) / ONE;
}

/** The band's edges, 18 decimals, around the feed's bid and ask at 8 decimals. */
export function band(
	bid: bigint,
	ask: bigint,
): { lower: bigint; upper: bigint } {
	return {
		lower: (bid * 10n ** 10n * (ONE - BAND)) / ONE,
		upper: (ask * 10n ** 10n * (ONE + BAND)) / ONE,
	};
}

/** The feed's round, as the keeper reads it: prices at 8 decimals, its publication, its session. */
export type Quote = {
	price: bigint;
	bid: bigint;
	ask: bigint;
	publishedAt: bigint;
	session: number;
};

/** Why the keeper stays still: the market is closed, the feed makes no sense, it is old, or frozen. */
export type IdleReason = "closed" | "insane" | "stale" | "frozen";

/** Why the keeper stays still now, or null when it may act. */
export function idleReason(
	quote: Quote,
	now: bigint,
	freezesAt: bigint,
): IdleReason | null {
	if (quote.session === 0 || quote.session === 5) return "closed";
	if (quote.price <= 0n || quote.bid <= 0n || quote.bid > quote.ask)
		return "insane";
	if (now - quote.publishedAt > MAX_AGE) return "stale";
	if (now >= freezesAt) return "frozen";
	return null;
}
