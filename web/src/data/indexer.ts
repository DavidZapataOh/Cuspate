/**
 * The one place the interface reads the indexer: the markets the protocol's events created, their
 * seals, pools, legs and trades, and each address's balances, through the indexer's GraphQL endpoint.
 * Server side only; the endpoint is INDEXER_GRAPHQL_URL. Amounts come back as decimal strings and
 * addresses in lower case, as the indexer stores them; this module turns them into bigints.
 */

/** Where the indexer answers: INDEXER_GRAPHQL_URL, or nothing when it is not set. */
export function indexerUrl(): string | undefined {
	return process.env.INDEXER_GRAPHQL_URL || undefined;
}

/**
 * Runs one query against the indexer.
 * @throws when the endpoint does not answer or answers with errors.
 */
export async function query<T>(
	text: string,
	variables: Record<string, unknown> = {},
	fetcher: typeof fetch = fetch,
): Promise<T> {
	const url = indexerUrl();
	if (!url) throw new Error("INDEXER_GRAPHQL_URL is not set");
	const response = await fetcher(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query: text, variables }),
		cache: "no-store",
	});
	if (!response.ok) throw new Error(`the indexer answered ${response.status}`);
	const body = (await response.json()) as {
		data?: T;
		errors?: { message?: string }[];
	};
	if (body.errors?.length || !body.data)
		throw new Error(
			`the indexer refused the query: ${body.errors?.[0]?.message ?? "no data"}`,
		);
	return body.data;
}

/** A pool as indexed. */
export type IndexedPool = {
	id: string;
	market: string;
	kind: "yes" | "no" | "probability";
	currency0: string;
	currency1: string;
	freezesAt: bigint;
};

/** A market as indexed, with its seal, pools and the supply of its dollar vault's legs. */
export type IndexedMarket = {
	id: string;
	eventId: string;
	condition: string;
	underlyingVault: string;
	dollarVault: string;
	seal?: {
		sealBlock: bigint;
		value: bigint;
		decimals: number;
		announcesAt: bigint;
		deadline: bigint;
	};
	pools: IndexedPool[];
	/** The supply of the dollar vault's yes leg: the dollars deposited in it, in the dollar's units. */
	dollarsIn: bigint;
	/** The outcome the conditions report, by the contracts' number; 0 while unresolved. */
	outcome: number;
	/** The resolver's record of the event: its open round, and every round proposed so far. */
	resolution: IndexedResolution;
};

/** One proposed figure in an event's resolution, as the resolver recorded it. */
export type IndexedProposal = {
	round: number;
	proposer: string;
	proposedAt: bigint;
	invalid: boolean;
	settled: boolean;
	figure: bigint;
	decimals: number;
	disputer: string;
	ruled: boolean;
	reason: string;
};

/** An event's resolution: the round now open, whether it waits for the arbiter, its proposals. */
export type IndexedResolution = {
	round: number;
	pendingArbitration: boolean;
	proposals: IndexedProposal[];
};

/** A trade in a pool: its block and place, and the price it left the pool at. */
export type IndexedSwap = {
	pool: string;
	block: bigint;
	logIndex: number;
	sqrtPriceX96: bigint;
};

type Raw = {
	Market: {
		id: string;
		eventId: string;
		condition: string;
		underlyingVault: string;
		dollarVault: string;
	}[];
	Seal: {
		id: string;
		sealBlock: string;
		value: string;
		decimals: number;
		announcesAt: string;
		deadline: string;
	}[];
	Pool: {
		id: string;
		market: string;
		kind: string;
		currency0: string;
		currency1: string;
		freezesAt: string;
	}[];
	Vault: { id: string; yes: string }[];
	Leg: { id: string; supply: string }[];
	Condition: { id: string; outcome: number }[];
	Resolution?: { id: string; round: number; pendingArbitration: boolean }[];
	Proposal?: {
		resolution: string;
		round: number;
		proposer: string;
		proposedAt: string;
		invalid: boolean;
		settled: boolean;
		figure: string;
		decimals: number;
		disputer: string;
		ruled: boolean;
		reason: string;
	}[];
};

const MARKETS = `query Markets($ids: [String!]!) {
	Market(where: { id: { _in: $ids } }) { id eventId condition underlyingVault dollarVault }
	Seal { id sealBlock value decimals announcesAt deadline }
	Pool(where: { market: { _in: $ids } }) { id market kind currency0 currency1 freezesAt }
	Vault { id yes }
	Leg { id supply }
	Condition { id outcome }
	Resolution { id round pendingArbitration }
	Proposal { resolution round proposer proposedAt invalid settled figure decimals disputer ruled reason }
}`;

/** Joins what the indexer holds about a set of markets into one record per market. */
export function marketsFrom(raw: Raw): IndexedMarket[] {
	const seals = new Map(raw.Seal.map((s) => [s.id, s]));
	const yesLeg = new Map(raw.Vault.map((v) => [v.id, v.yes]));
	const supply = new Map(raw.Leg.map((l) => [l.id, BigInt(l.supply)]));
	const outcomes = new Map(raw.Condition.map((c) => [c.id, c.outcome]));
	const resolutions = new Map((raw.Resolution ?? []).map((r) => [r.id, r]));
	return raw.Market.map((m) => {
		const seal = seals.get(m.eventId);
		const leg = yesLeg.get(m.dollarVault);
		return {
			id: m.id,
			eventId: m.eventId,
			condition: m.condition,
			underlyingVault: m.underlyingVault,
			dollarVault: m.dollarVault,
			seal: seal && {
				sealBlock: BigInt(seal.sealBlock),
				value: BigInt(seal.value),
				decimals: seal.decimals,
				announcesAt: BigInt(seal.announcesAt),
				deadline: BigInt(seal.deadline),
			},
			pools: raw.Pool.filter((p) => p.market === m.id).map((p) => ({
				id: p.id,
				market: p.market,
				kind: p.kind as IndexedPool["kind"],
				currency0: p.currency0,
				currency1: p.currency1,
				freezesAt: BigInt(p.freezesAt),
			})),
			dollarsIn: (leg ? supply.get(leg) : undefined) ?? 0n,
			outcome: outcomes.get(m.condition) ?? 0,
			resolution: {
				round: resolutions.get(m.eventId)?.round ?? 0,
				pendingArbitration:
					resolutions.get(m.eventId)?.pendingArbitration ?? false,
				proposals: (raw.Proposal ?? [])
					.filter((p) => p.resolution === m.eventId)
					.map((p) => ({
						round: p.round,
						proposer: p.proposer,
						proposedAt: BigInt(p.proposedAt),
						invalid: p.invalid,
						settled: p.settled,
						figure: BigInt(p.figure),
						decimals: p.decimals,
						disputer: p.disputer,
						ruled: p.ruled,
						reason: p.reason,
					}))
					.sort((a, b) => a.round - b.round),
			},
		};
	});
}

/** The indexed markets among `ids` (market ids, lower case). */
export async function indexedMarkets(ids: string[]): Promise<IndexedMarket[]> {
	return marketsFrom(await query<Raw>(MARKETS, { ids }));
}

/** An indexer id of a log, "<block>-<log index>", as its block and index. */
export function logPlace(id: string): { block: bigint; logIndex: number } {
	const [block = "0", index = "0"] = id.split("-");
	return { block: BigInt(block), logIndex: Number(index) };
}

/** Every indexed trade in the given pools, in chain order. */
export async function indexedSwaps(pools: string[]): Promise<IndexedSwap[]> {
	const { Swap } = await query<{
		Swap: { id: string; pool: string; sqrtPriceX96: string }[];
	}>(
		`query Swaps($pools: [String!]!) {
			Swap(where: { pool: { _in: $pools } }) { id pool sqrtPriceX96 }
		}`,
		{ pools },
	);
	return Swap.map((s) => ({
		pool: s.pool,
		sqrtPriceX96: BigInt(s.sqrtPriceX96),
		...logPlace(s.id),
	})).sort((a, b) =>
		a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1,
	);
}

/** An address's balance of every leg it holds, by leg (lower case), in each leg's units. */
export async function indexedBalances(
	holder: string,
): Promise<Map<string, bigint>> {
	const { Balance } = await query<{
		Balance: { leg: string; amount: string }[];
	}>(
		`query Balances($holder: String!) {
			Balance(where: { holder: { _eq: $holder } }) { leg amount }
		}`,
		{ holder: holder.toLowerCase() },
	);
	return new Map(Balance.map((b) => [b.leg, BigInt(b.amount)]));
}
