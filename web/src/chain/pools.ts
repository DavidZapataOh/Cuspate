/**
 * A market's pools as the protocol derives them, so the interface quotes exactly the pool the router
 * will trade in.
 */
import type { Address } from "viem";
import type { MarketBinding } from "../data/model.ts";

/** Every pool's fee, in millionths: 0.30%. */
export const POOL_FEE = 3000;

/** Every pool's tick spacing. */
export const TICK_SPACING = 60;

/** A pool's key, as the pool manager identifies it. */
export type PoolKey = {
	currency0: Address;
	currency1: Address;
	fee: number;
	tickSpacing: number;
	hooks: Address;
};

/** The key of the pool between two tokens: the pair in address order, the fee, the spacing, the hook. */
export function poolKeyOf(a: Address, b: Address, hook: Address): PoolKey {
	const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
	return {
		currency0,
		currency1,
		fee: POOL_FEE,
		tickSpacing: TICK_SPACING,
		hooks: hook,
	};
}

/** The pool a purchase in one world trades in, and the direction of its sale of that world's dollar. */
export function worldPool(
	legs: MarketBinding["legs"],
	yes: boolean,
	hook: Address,
): { key: PoolKey; zeroForOne: boolean } {
	const [dollar, share] = yes
		? [legs.dollarYes, legs.underlyingYes]
		: [legs.dollarNo, legs.underlyingNo];
	const key = poolKeyOf(dollar, share, hook);
	return { key, zeroForOne: key.currency0 === dollar };
}
