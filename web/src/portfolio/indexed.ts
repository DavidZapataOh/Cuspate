import "server-only";
/**
 * The portfolio's positions for one address, from the indexer: the legs it holds in each recorded
 * market, the market's vaults, when its pools freeze and the outcome its condition reports. One query
 * per kind of record, however many markets there are.
 */
import { type Address, getAddress } from "viem";
import {
	type IndexedMarket,
	indexedBalances,
	indexedMarkets,
} from "../data/indexer.ts";
import type { Listed } from "./chain.ts";
import { OUTCOMES, type Position } from "./position.ts";

/** One market's position, from what the indexer holds about it and the address's balances. */
export function positionFrom(
	owner: Address,
	listed: Listed,
	market: IndexedMarket,
	balances: Map<string, bigint>,
): Position {
	const { legs } = listed.market;
	const held = (leg: Address) => balances.get(leg.toLowerCase()) ?? 0n;
	const yesPool = market.pools.find((p) => p.kind === "yes");
	return {
		eventKey: listed.eventKey,
		conditionKey: listed.conditionKey,
		issuer: listed.issuer,
		holder: owner,
		marketId: listed.market.marketId,
		underlyingVault: getAddress(market.underlyingVault),
		dollarVault: listed.market.dollarVault,
		legs,
		holdings: {
			underlyingYes: held(legs.underlyingYes),
			underlyingNo: held(legs.underlyingNo),
			dollarYes: held(legs.dollarYes),
			dollarNo: held(legs.dollarNo),
		},
		freezesAt: Number(yesPool?.freezesAt ?? 0n),
		outcome: OUTCOMES[market.outcome] ?? "unresolved",
	};
}

/** Every recorded market the indexer knows, as a position of an address, holdings of nothing included. */
export async function indexedPositionsOf(
	owner: Address,
	listed: Listed[],
): Promise<Position[]> {
	const [markets, balances] = await Promise.all([
		indexedMarkets(listed.map((l) => l.market.marketId.toLowerCase())),
		indexedBalances(owner),
	]);
	const byId = new Map(markets.map((m) => [m.id, m]));
	return listed.flatMap((l) => {
		const market = byId.get(l.market.marketId.toLowerCase());
		return market ? [positionFrom(owner, l, market, balances)] : [];
	});
}
