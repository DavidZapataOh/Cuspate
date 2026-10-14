/**
 * Which conditions have a market on chain, read from the deployment record: the opening of each
 * market writes it there under "<event>/<condition>", with the ids and tokens a purchase needs.
 */
import { type Address, getAddress, type Hex, isAddress, isHex } from "viem";
import type { MarketBinding, ReadLayer } from "./model.ts";

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

/** A read layer whose conditions carry their market wherever the record lists one. */
export function withMarkets(
	layer: ReadLayer,
	markets: Map<string, MarketBinding>,
): ReadLayer {
	const bind = <E extends { eventKey: string; conditions: { key: string }[] }>(
		event: E,
	): E => ({
		...event,
		conditions: event.conditions.map((c) => {
			const market = markets.get(`${event.eventKey}/${c.key}`);
			return market ? { ...c, market } : c;
		}),
	});
	return {
		...layer,
		events: async (now) => (await layer.events(now)).map(bind),
		event: async (key, now) => {
			const event = await layer.event(key, now);
			return event && bind(event);
		},
	};
}
