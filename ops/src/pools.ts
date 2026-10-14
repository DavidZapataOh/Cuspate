/**
 * The pool arithmetic the seeding needs, ported from the pool manager's own libraries so the prices
 * and amounts sent are the ones the pool will compute: the square-root price at a tick and back, the
 * liquidity a deposit buys within a range and what that liquidity costs, the prices a market's three
 * pools open at, and the batch a Safe sends through MultiSendCallOnly.
 */
import {
	type Address,
	concat,
	encodeFunctionData,
	encodePacked,
	type Hex,
	parseAbi,
	size,
} from "viem";

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const Q96 = 2n ** 96n;
const MAX_UINT256 = 2n ** 256n - 1n;

const STEPS: readonly [number, bigint][] = [
	[0x2, 0xfff97272373d413259a46990580e213an],
	[0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
	[0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
	[0x10, 0xffcb9843d60f6159c9db58835c926644n],
	[0x20, 0xff973b41fa98c081472e6896dfb254c0n],
	[0x40, 0xff2ea16466c96a3843ec78b326b52861n],
	[0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
	[0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
	[0x200, 0xf987a7253ac413176f2b074cf7815e54n],
	[0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
	[0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
	[0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
	[0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
	[0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
	[0x8000, 0x31be135f97d08fd981231505542fcfa6n],
	[0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
	[0x20000, 0x5d6af8dedb81196699c329225ee604n],
	[0x40000, 0x2216e584f5fa1ea926041bedfe98n],
	[0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** The square-root price, as a Q64.96, at a tick: the pool manager's TickMath. */
export function sqrtPriceAtTick(tick: number): bigint {
	if (tick < MIN_TICK || tick > MAX_TICK)
		throw new Error(`tick ${tick} is out of range`);
	const abs = Math.abs(tick);
	let ratio =
		abs & 0x1
			? 0xfffcb933bd6fad37aa2d162d1a594001n
			: 0x100000000000000000000000000000000n;
	for (const [bit, factor] of STEPS)
		if (abs & bit) ratio = (ratio * factor) >> 128n;
	if (tick > 0) ratio = MAX_UINT256 / ratio;
	return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** The greatest tick whose square-root price is at or below `price`. */
export function tickAtSqrtPrice(price: bigint): number {
	let low = MIN_TICK;
	let high = MAX_TICK;
	while (low < high) {
		const mid = Math.floor((low + high + 1) / 2);
		if (sqrtPriceAtTick(mid) <= price) low = mid;
		else high = mid - 1;
	}
	return low;
}

/** A range `halfWidth` ticks either side of a price, on the spacing, its upper end one spacing up. */
export function rangeAround(price: bigint, halfWidth: number, spacing: number) {
	const tick = tickAtSqrtPrice(price);
	const floor = (t: number) => Math.floor(t / spacing) * spacing;
	return {
		lower: floor(tick - halfWidth),
		upper: floor(tick + halfWidth) + spacing,
	};
}

/** The floor of the square root. */
function sqrt(value: bigint): bigint {
	if (value < 2n) return value;
	let x = value;
	let y = (x + 1n) / 2n;
	while (y < x) {
		x = y;
		y = (x + value / x) / 2n;
	}
	return x;
}

/** The square root of `num / den` as a Q64.96, rounded down. */
function sqrtRatio(num: bigint, den: bigint): bigint {
	return sqrt((num << 192n) / den);
}

/**
 * A conditional pool's opening price: one share worth the stock's price in dollars, `spot` with eight
 * decimals as the feed publishes it. The pool prices token1 in raw units per raw unit of token0, so the
 * decimals of both apply, and the price inverts when the share is token1.
 */
export function conditionalSqrtPrice(
	spot: bigint,
	shareIsToken0: boolean,
	shareDecimals: number,
	dollarDecimals: number,
): bigint {
	const num = spot * 10n ** BigInt(dollarDecimals);
	const den = 10n ** BigInt(8 + shareDecimals);
	return shareIsToken0 ? sqrtRatio(num, den) : sqrtRatio(den, num);
}

/** The probability pool's opening price: the yes-dollar worth `chance` dollars, in no-dollars. */
export function probabilitySqrtPrice(
	chance: number,
	yesFirst: boolean,
): bigint {
	const yes = BigInt(Math.round(chance * 10_000));
	if (yes <= 0n || yes >= 10_000n)
		throw new Error(`a chance strictly between 0 and 1, not ${chance}`);
	const no = 10_000n - yes;
	return yesFirst ? sqrtRatio(yes, no) : sqrtRatio(no, yes);
}

function liquidity0(a: bigint, b: bigint, amount: bigint): bigint {
	return (amount * ((a * b) / Q96)) / (b - a);
}

function liquidity1(a: bigint, b: bigint, amount: bigint): bigint {
	return (amount * Q96) / (b - a);
}

/** The most liquidity `amount0` and `amount1` buy in a range at a price. */
export function liquidityFor(
	price: bigint,
	lower: number,
	upper: number,
	amount0: bigint,
	amount1: bigint,
): bigint {
	const a = sqrtPriceAtTick(lower);
	const b = sqrtPriceAtTick(upper);
	if (price <= a) return liquidity0(a, b, amount0);
	if (price >= b) return liquidity1(a, b, amount1);
	const l0 = liquidity0(price, b, amount0);
	const l1 = liquidity1(a, price, amount1);
	return l0 < l1 ? l0 : l1;
}

function divUp(a: bigint, b: bigint): bigint {
	return a / b + (a % b === 0n ? 0n : 1n);
}

/** What a liquidity costs in a range at a price, rounded up as the pool rounds a deposit. */
export function amountsFor(
	price: bigint,
	lower: number,
	upper: number,
	liquidity: bigint,
) {
	const a = sqrtPriceAtTick(lower);
	const b = sqrtPriceAtTick(upper);
	const p = price < a ? a : price > b ? b : price;
	const amount0 = p >= b ? 0n : divUp(divUp(liquidity * Q96 * (b - p), b), p);
	const amount1 = p <= a ? 0n : divUp(liquidity * (p - a), Q96);
	return { amount0, amount1 };
}

const MULTI_SEND = parseAbi(["function multiSend(bytes transactions)"]);

/** The calls a Safe makes in one transaction, encoded for MultiSendCallOnly: each a plain call. */
export function multiSendData(
	calls: readonly { to: Address; data: Hex }[],
): Hex {
	const packed = concat(
		calls.map((call) =>
			encodePacked(
				["uint8", "address", "uint256", "uint256", "bytes"],
				[0, call.to, 0n, BigInt(size(call.data)), call.data],
			),
		),
	);
	return encodeFunctionData({
		abi: MULTI_SEND,
		functionName: "multiSend",
		args: [packed],
	});
}
