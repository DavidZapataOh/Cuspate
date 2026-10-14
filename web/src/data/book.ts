/**
 * Which conditions have a market on chain, read from the deployment record: the opening of each
 * market writes it there under "<event>/<condition>", with the ids and tokens a purchase needs.
 */
import { type Address, getAddress, type Hex, isAddress, isHex } from "viem";
import type { MarketBinding } from "./model.ts";

type Recorded = {
	marketId?: unknown;
	dollarVault?: unknown;
	legs?: Record<string, unknown>;
};

function address(value: unknown, where: string): Address {
	if (typeof value !== "string" || !isAddress(value))
		throw new Error(`${where}: not an address`);
	return getAddress(value);
}

/**
 * The markets a deployment record lists, by "<event>/<condition>".
 * @throws for a market recorded without its id or one of its tokens.
 */
export function marketsOf(book: {
	markets?: Record<string, unknown>;
}): Map<string, MarketBinding> {
	const markets = new Map<string, MarketBinding>();
	for (const [key, value] of Object.entries(book.markets ?? {})) {
		const entry = value as Recorded;
		if (!isHex(entry.marketId) || entry.marketId.length !== 66)
			throw new Error(`${key}: no market id`);
		if (!entry.legs) throw new Error(`${key}: no tokens`);
		const legs = entry.legs;
		markets.set(key, {
			marketId: entry.marketId as Hex,
			dollarVault: address(entry.dollarVault, key),
			legs: {
				underlyingYes: address(legs.underlyingYes, key),
				underlyingNo: address(legs.underlyingNo, key),
				dollarYes: address(legs.dollarYes, key),
				dollarNo: address(legs.dollarNo, key),
			},
		});
	}
	return markets;
}
