/**
 * The read layer the screens use. Which markets exist, their sealed thresholds, their pools, the
 * dollars in them and every trade come from the indexer (see `indexer.ts`), which follows the
 * protocol's events; what moves with every block is read from the chain itself when a page asks: the
 * pools' prices, through the network's StateView, and the stock's price, from the price feed. The
 * resolver's terms and the tokens' decimals are read from the contracts once. The issuer facts no
 * contract holds (the quarter, the release timing, whether the company confirmed the date, the
 * sector) come from the test network's event manifest, the file the markets were opened from; the
 * names of the markets and their sealing transactions, from the deployment record.
 */
import {
	type Address,
	BaseError,
	createPublicClient,
	getAddress,
	type Hex,
	http,
	keccak256,
	type PublicClient,
	parseAbi,
	toHex,
} from "viem";
import manifest from "../../../ops/events/10143.json" with { type: "json" };
import { rpcUrl } from "../chain/endpoint.ts";
import { poolKeyOf, worldPool } from "../chain/pools.ts";
import { TESTNET } from "../chain/record.ts";
import { poolIdOf } from "../portfolio/chain.ts";
import { OUTCOMES } from "../portfolio/position.ts";
import { marketsOf } from "./book.ts";
import {
	centsOf,
	chanceOf,
	feeBpsOf,
	pans,
	worldPriceCents,
	yesDollarPrice,
} from "./derive.ts";
import {
	type IndexedResolution,
	type IndexedSwap,
	indexedMarkets,
	indexedSwaps,
	indexerUrl,
} from "./indexer.ts";
import type {
	ChancePoint,
	Condition,
	MarketBinding,
	MarketEvent,
	ReadLayer,
	Resolution,
	Settlement,
} from "./model.ts";

const abi = {
	stateView: parseAbi([
		"function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
	]),
	erc20: parseAbi([
		"function balanceOf(address) view returns (uint256)",
		"function decimals() view returns (uint8)",
		"function totalSupply() view returns (uint256)",
	]),
	oracle: parseAbi([
		"function latestPrice(bytes32 priceId) view returns (int128 price, int128 bestBid, int128 bestAsk, uint64 feedUpdateTimestamp, uint64 publishedAt, uint80 roundId, uint8 session)",
	]),
	resolver: parseAbi([
		"function LIVENESS() view returns (uint256)",
		"function ARBITER_TIMEOUT() view returns (uint256)",
		"function EXPIRY() view returns (uint256)",
		"function BOND() view returns (uint256)",
		"function BOND_TOKEN() view returns (address)",
		"function ARBITER() view returns (address)",
	]),
	hook: parseAbi(["function GUARDIAN() view returns (address)"]),
	registry: parseAbi([
		"function sealOf(bytes32 eventId) view returns (address sealer, uint256 sealBlock, (int256 value, uint8 decimals, uint64 announcesAt, uint64 deadline, bytes terms) threshold)",
	]),
	resolverState: parseAbi([
		"function eventOf(bytes32 eventId) view returns ((uint8 round, bool pendingArbitration, (address proposer, uint256 proposedAt, bool invalid, bool settled, int256 figure, uint8 decimals, address disputer, bool ruled, uint64 ruledAt, string reason)[2] rounds, string outcomeReason))",
	]),
	vault: parseAbi([
		"function OUTCOMES() view returns (address)",
		"function CONDITION() view returns (bytes32)",
	]),
	outcomes: parseAbi(["function outcomeOf(bytes32) view returns (uint8)"]),
};

/** The fewest milliseconds between two requests to the endpoint: under seven a second, inside its limit. */
const REQUEST_SPACING_MS = 150;
/** How long a reading of the pools, vaults and feed is reused, in milliseconds. */
const FRESH_MS = 20_000;

type Book = {
	markets?: Record<string, unknown>;
	thirdParty?: Record<string, string[]>;
} & Record<string, unknown>;

/** A market as the record lists it, with what the read layer needs beyond its binding. */
type Listed = {
	eventKey: string;
	conditionKey: string;
	issuer: string;
	eventId: Hex;
	block: bigint;
	sealTx?: string;
	binding: MarketBinding;
	/** The probability pool's id and whether the yes-dollar is its first currency. */
	probability: { id: Hex; yesFirst: boolean };
	yesPool: { id: Hex; shareIsToken0: boolean };
	noPool: { id: Hex; shareIsToken0: boolean };
	/** The price the probability pool was opened at, as the record took it from the receipts. */
	opened?: { sqrtPriceX96: bigint };
};

/** The feed's id for a ticker: the hash of the upper-case symbol. */
export function priceIdOf(ticker: string): Hex {
	return keccak256(toHex(ticker.toUpperCase()));
}

function named(book: Book, name: string): Address {
	const entry = book[name] as { address?: string } | undefined;
	if (!entry?.address) throw new Error(`no ${name} in the deployment record`);
	return getAddress(entry.address);
}

function thirdParty(book: Book, name: string): Address {
	const address = book.thirdParty?.[name]?.[0];
	if (!address) throw new Error(`no ${name} in the deployment record`);
	return getAddress(address);
}

/** The markets a record lists, with the pools each trades in. */
export function listedOf(book: Book, hook: Address): Listed[] {
	const bindings = marketsOf(book);
	return Object.entries(book.markets ?? {}).map(([key, value]) => {
		const entry = value as {
			eventKey: string;
			condition: string;
			issuer: string;
			eventId: Hex;
			block: number;
			sealTx?: string;
			pools?: { currency0: string; currency1: string; sqrtPriceX96: string }[];
		};
		const binding = bindings.get(key);
		if (!binding) throw new Error(`${key}: not bound`);
		const { legs } = binding;
		const probabilityKey = poolKeyOf(legs.dollarYes, legs.dollarNo, hook);
		const yes = worldPool(legs, true, hook);
		const no = worldPool(legs, false, hook);
		return {
			eventKey: entry.eventKey,
			conditionKey: entry.condition,
			issuer: entry.issuer,
			eventId: entry.eventId,
			block: BigInt(entry.block),
			sealTx: entry.sealTx,
			binding,
			probability: {
				id: poolIdOf(probabilityKey),
				yesFirst: probabilityKey.currency0 === legs.dollarYes,
			},
			yesPool: { id: poolIdOf(yes.key), shareIsToken0: !yes.zeroForOne },
			noPool: { id: poolIdOf(no.key), shareIsToken0: !no.zeroForOne },
			opened: openedOf(entry.pools, probabilityKey),
		};
	});
}

/** The recorded opening price of the pool with a key's currencies, if the record holds one. */
function openedOf(
	pools:
		| { currency0: string; currency1: string; sqrtPriceX96: string }[]
		| undefined,
	key: ReturnType<typeof poolKeyOf>,
): { sqrtPriceX96: bigint } | undefined {
	const pool = pools?.find(
		(p) =>
			getAddress(p.currency0) === key.currency0 &&
			getAddress(p.currency1) === key.currency1,
	);
	return pool ? { sqrtPriceX96: BigInt(pool.sqrtPriceX96) } : undefined;
}

type ManifestEvent = {
	eventKey: string;
	period: MarketEvent["period"];
	releaseTiming: MarketEvent["releaseTiming"];
	dateSource: { confirmed: boolean };
	sector: string;
	conditions: { key: string; primary: boolean }[];
};

const MANIFEST = (manifest as unknown as { events: ManifestEvent[] }).events;

/** The facts the chain does not hold about an event, from the manifest it was opened from. */
function factsOf(eventKey: string): ManifestEvent {
	const facts = MANIFEST.find((e) => e.eventKey === eventKey);
	if (!facts) throw new Error(`${eventKey}: not in the event manifest`);
	return facts;
}

/** What never changes once a market is open: decimals, the resolver's terms, where outcomes are read. */
type Fixed = {
	shareDecimals: Map<string, number>;
	dollarDecimals: Map<string, number>;
	settlementDollarDecimals: number;
	settlement: Settlement;
};

/** What the protocol's events say about one market, from the indexer or, without it, the chain. */
export type MarketState = {
	seal?: {
		sealBlock: bigint;
		value: bigint;
		decimals: number;
		announcesAt: bigint;
	};
	/** The supply of the dollar vault's yes leg: the dollars deposited, in the dollar's units. */
	dollarsIn: bigint;
	/** The outcome by the contracts' number; 0 while unresolved. */
	outcome: number;
	resolution: IndexedResolution;
};

/** What moves: each market's state, the pools' prices and the feed. */
type Moving = {
	/** Where the markets' state came from: the indexer, or the chain when the indexer is unavailable. */
	source: "indexer" | "chain";
	/** Each market's state, by market id in lower case; a market missing here is not shown. */
	markets: Map<string, MarketState>;
	/** Each pool's state, by pool id in lower case. */
	slot0: Map<string, { sqrtPriceX96: bigint; lpFee: number }>;
	spotCents: Map<string, { cents: bigint; publishedAt: string }>;
	/** Seal blocks' times, in milliseconds. */
	sealTimes: Map<bigint, number>;
	/** Every indexed trade in the markets' probability pools, in chain order; none without the indexer. */
	swaps?: IndexedSwap[];
};

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Runs a read again after a pause when it fails: the public endpoint refuses requests past its rate,
 * and a refused batch comes back as failed calls.
 */
async function patiently<T>(read: () => Promise<T>, tries = 5): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await read();
		} catch (error) {
			if (attempt >= tries) throw error;
			await new Promise((r) => setTimeout(r, 500 * attempt));
		}
	}
}

/** Whether a failed call reverted, as opposed to never reaching the contract. */
function reverted(error: unknown): boolean {
	return (
		error instanceof BaseError &&
		error.walk((e) => (e as Error).name === "ContractFunctionRevertedError") !==
			null
	);
}

function ok<T>(r: { status: string; result?: unknown }, what: string): T {
	if (r.status !== "success") throw new Error(`could not read ${what}`);
	return r.result as T;
}

/** The resolver's own record of an event, as `eventOf` returns it, in the indexer's shape. */
export function resolutionFromChain(state: {
	round: number;
	pendingArbitration: boolean;
	rounds: readonly {
		proposer: string;
		proposedAt: bigint;
		invalid: boolean;
		settled: boolean;
		figure: bigint;
		decimals: number;
		disputer: string;
		ruled: boolean;
		reason: string;
	}[];
}): IndexedResolution {
	return {
		round: state.round,
		pendingArbitration: state.pendingArbitration,
		proposals: state.rounds
			.map((r, round) => ({
				round,
				proposer: r.proposer.toLowerCase(),
				proposedAt: r.proposedAt,
				invalid: r.invalid,
				settled: r.settled,
				figure: r.figure,
				decimals: r.decimals,
				disputer: r.disputer.toLowerCase(),
				ruled: r.ruled,
				reason: r.reason,
			}))
			.filter((r) => r.proposer !== ZERO),
	};
}

/** An event's resolution as the screens show it. */
export function resolutionOf(
	state: IndexedResolution,
	outcome: number,
): Resolution {
	return {
		pendingArbitration: state.pendingArbitration,
		outcome: OUTCOMES[outcome] ?? "unresolved",
		rounds: state.proposals.map((p) => ({
			round: p.round,
			proposer: p.proposer,
			proposedAt: Number(p.proposedAt),
			invalid: p.invalid,
			figure: p.figure,
			decimals: p.decimals,
			disputer: p.disputer === ZERO ? undefined : p.disputer,
			settled: p.settled,
			ruled: p.ruled,
			reason: p.reason,
		})),
	};
}

let warnedNoIndexer = false;

/** A read layer over a deployment record, reading through one client. */
export function chainLayer(book: Book, client: PublicClient): ReadLayer {
	const hook = named(book, "FreezeHook");
	const resolver = named(book, "OptimisticResolver");
	const registry = named(book, "ThresholdRegistry");
	const oracle = named(book, "TestnetStockOracle");
	const dollar = named(book, "TestnetDollar");
	const stateView = thirdParty(book, "stateView");
	const listed = listedOf(book, hook);
	const issuers = [...new Set(listed.map((m) => m.issuer))];
	const blockTimes = new Map<bigint, Promise<number>>();
	const idOf = (m: Listed) => m.binding.marketId.toLowerCase();

	/** A block's time in milliseconds, read once. */
	function timeOf(block: bigint): Promise<number> {
		let time = blockTimes.get(block);
		if (!time) {
			time = client
				.getBlock({ blockNumber: block })
				.then((b) => Number(b.timestamp) * 1000);
			blockTimes.set(block, time);
			time.catch(() => blockTimes.delete(block));
		}
		return time;
	}

	let fixed: Promise<Fixed> | undefined;
	let moving: { at: number; value: Promise<Moving> } | undefined;
	let outcomeSources:
		| Promise<{ outcomes: Address; condition: Hex }[]>
		| undefined;

	async function readFixed(): Promise<Fixed> {
		const results = await client.multicall({
			allowFailure: true,
			contracts: [
				...listed.map(
					(m) =>
						({
							address: m.binding.legs.underlyingYes,
							abi: abi.erc20,
							functionName: "decimals",
						}) as const,
				),
				...listed.map(
					(m) =>
						({
							address: m.binding.legs.dollarYes,
							abi: abi.erc20,
							functionName: "decimals",
						}) as const,
				),
				{ address: dollar, abi: abi.erc20, functionName: "decimals" },
				{ address: resolver, abi: abi.resolver, functionName: "LIVENESS" },
				{
					address: resolver,
					abi: abi.resolver,
					functionName: "ARBITER_TIMEOUT",
				},
				{ address: resolver, abi: abi.resolver, functionName: "EXPIRY" },
				{ address: resolver, abi: abi.resolver, functionName: "BOND" },
				{ address: resolver, abi: abi.resolver, functionName: "BOND_TOKEN" },
				{ address: resolver, abi: abi.resolver, functionName: "ARBITER" },
				{ address: hook, abi: abi.hook, functionName: "GUARDIAN" },
			],
		});
		const n = listed.length;
		const at = (i: number) =>
			results[i] as { status: string; result?: unknown };
		const shareDecimals = new Map<string, number>();
		const dollarDecimals = new Map<string, number>();
		listed.forEach((m, i) => {
			const key = `${m.eventKey}/${m.conditionKey}`;
			shareDecimals.set(key, ok<number>(at(i), `${key} share decimals`));
			dollarDecimals.set(key, ok<number>(at(n + i), `${key} dollar decimals`));
		});
		const base = 2 * n;
		const settlementDollarDecimals = ok<number>(at(base), "dollar decimals");
		const bondToken = ok<Address>(at(base + 5), "bond token");
		const bondDecimals =
			getAddress(bondToken) === dollar
				? settlementDollarDecimals
				: await client.readContract({
						address: bondToken,
						abi: abi.erc20,
						functionName: "decimals",
					});
		return {
			shareDecimals,
			dollarDecimals,
			settlementDollarDecimals,
			settlement: {
				network: TESTNET.name,
				livenessSeconds: Number(ok<bigint>(at(base + 1), "liveness")),
				arbiterTimeoutSeconds: Number(
					ok<bigint>(at(base + 2), "arbiter timeout"),
				),
				expirySeconds: Number(ok<bigint>(at(base + 3), "expiry")),
				bondCents: centsOf(ok<bigint>(at(base + 4), "bond"), bondDecimals),
				arbiter: ok<Address>(at(base + 6), "arbiter"),
				guardian: ok<Address>(at(base + 7), "guardian"),
			},
		};
	}

	/** Each market's state from the indexer. */
	async function fromIndexer(): Promise<Map<string, MarketState>> {
		const indexed = await indexedMarkets(listed.map(idOf));
		return new Map(
			indexed.map((m) => [
				m.id,
				{
					seal: m.seal,
					dollarsIn: m.dollarsIn,
					outcome: m.outcome,
					resolution: m.resolution,
				},
			]),
		);
	}

	/** Where each market's outcome is read: its dollar vault's outcome source and condition. */
	function readOutcomeSources() {
		if (!outcomeSources) {
			outcomeSources = client
				.multicall({
					allowFailure: false,
					contracts: listed.flatMap(
						(m) =>
							[
								{
									address: m.binding.dollarVault,
									abi: abi.vault,
									functionName: "OUTCOMES",
								},
								{
									address: m.binding.dollarVault,
									abi: abi.vault,
									functionName: "CONDITION",
								},
							] as const,
					),
				})
				.then((r) =>
					listed.map((_, i) => ({
						outcomes: r[2 * i] as Address,
						condition: r[2 * i + 1] as Hex,
					})),
				);
			outcomeSources.catch(() => {
				outcomeSources = undefined;
			});
		}
		return outcomeSources;
	}

	/** Each market's state read from the contracts themselves, when the indexer is unavailable. */
	async function fromChain(): Promise<Map<string, MarketState>> {
		const sources = await readOutcomeSources();
		const results = await client.multicall({
			allowFailure: true,
			contracts: [
				...listed.map(
					(m) =>
						({
							address: registry,
							abi: abi.registry,
							functionName: "sealOf",
							args: [m.eventId],
						}) as const,
				),
				...listed.map(
					(m) =>
						({
							address: m.binding.legs.dollarYes,
							abi: abi.erc20,
							functionName: "totalSupply",
						}) as const,
				),
				...listed.map(
					(m) =>
						({
							address: resolver,
							abi: abi.resolverState,
							functionName: "eventOf",
							args: [m.eventId],
						}) as const,
				),
				...sources.map(
					(s) =>
						({
							address: s.outcomes,
							abi: abi.outcomes,
							functionName: "outcomeOf",
							args: [s.condition],
						}) as const,
				),
			],
		});
		const n = listed.length;
		const at = (i: number) =>
			results[i] as { status: string; result?: unknown };
		return new Map(
			listed.map((m, i) => {
				const key = `${m.eventKey}/${m.conditionKey}`;
				const [, sealBlock, threshold] = ok<
					readonly [
						Address,
						bigint,
						{ value: bigint; decimals: number; announcesAt: bigint },
					]
				>(at(i), `${key} seal`);
				const state = ok<{
					round: number;
					pendingArbitration: boolean;
					rounds: readonly {
						proposer: string;
						proposedAt: bigint;
						invalid: boolean;
						settled: boolean;
						figure: bigint;
						decimals: number;
						disputer: string;
						ruled: boolean;
						reason: string;
					}[];
				}>(at(2 * n + i), `${key} resolution`);
				return [
					idOf(m),
					{
						seal: {
							sealBlock,
							value: threshold.value,
							decimals: threshold.decimals,
							announcesAt: threshold.announcesAt,
						},
						dollarsIn: ok<bigint>(at(n + i), `${key} dollars in`),
						outcome: ok<number>(at(3 * n + i), `${key} outcome`),
						resolution: resolutionFromChain(state),
					},
				];
			}),
		);
	}

	/** The markets' state: from the indexer where it is set and answers, else from the chain. */
	async function marketStates(): Promise<{
		source: Moving["source"];
		markets: Map<string, MarketState>;
		swaps?: IndexedSwap[];
	}> {
		if (indexerUrl()) {
			try {
				// Two queries per reading, shared by every page for FRESH_MS: the hosted indexer
				// answers a limited number of queries a minute.
				const [markets, swaps] = await Promise.all([
					fromIndexer(),
					indexedSwaps(listed.map((m) => m.probability.id.toLowerCase())),
				]);
				return { source: "indexer", markets, swaps };
			} catch (error) {
				console.error(
					`the indexer did not answer; reading the markets from the chain: ${(error as Error).message}`,
				);
			}
		} else if (!warnedNoIndexer) {
			warnedNoIndexer = true;
			console.error(
				"INDEXER_GRAPHQL_URL is not set; reading the markets from the chain, without their trade history",
			);
		}
		return { source: "chain", markets: await fromChain() };
	}

	async function readMoving(): Promise<Moving> {
		const { source, markets, swaps } = await marketStates();
		const present = listed.filter((m) => markets.has(idOf(m)));
		const pools = present.flatMap((m) => [
			m.probability.id,
			m.yesPool.id,
			m.noPool.id,
		]);
		// What moves with every block, from the chain itself: the pools' prices and the feed.
		const results = await client.multicall({
			allowFailure: true,
			contracts: [
				...pools.map(
					(id) =>
						({
							address: stateView,
							abi: abi.stateView,
							functionName: "getSlot0",
							args: [id],
						}) as const,
				),
				...issuers.map(
					(t) =>
						({
							address: oracle,
							abi: abi.oracle,
							functionName: "latestPrice",
							args: [priceIdOf(t)],
						}) as const,
				),
			],
		});
		const at = (i: number) =>
			results[i] as { status: string; result?: unknown };
		const slot0 = new Map<string, { sqrtPriceX96: bigint; lpFee: number }>();
		pools.forEach((id, i) => {
			const [sqrtPriceX96, , , lpFee] = ok<
				readonly [bigint, number, number, number]
			>(at(i), `pool ${id}`);
			slot0.set(id.toLowerCase(), { sqrtPriceX96, lpFee });
		});
		const spotCents = new Map<string, { cents: bigint; publishedAt: string }>();
		issuers.forEach((t, i) => {
			const r = at(pools.length + i);
			// A symbol the feed has never published has no price: the screens then show none. Any
			// other failure is the endpoint's, and the read is tried again.
			if (r.status !== "success") {
				if (reverted((r as { error?: unknown }).error)) return;
				throw new Error(`could not read the feed for ${t}`);
			}
			const [price, , , , publishedAt] = r.result as readonly [
				bigint,
				bigint,
				bigint,
				bigint,
				bigint,
			];
			spotCents.set(t, {
				cents: centsOf(price, 8),
				publishedAt: new Date(Number(publishedAt) * 1000).toISOString(),
			});
		});
		const sealTimes = new Map<bigint, number>();
		await Promise.all(
			[...markets.values()].map(async (m) => {
				if (m.seal)
					sealTimes.set(m.seal.sealBlock, await timeOf(m.seal.sealBlock));
			}),
		);
		return { source, markets, slot0, spotCents, sealTimes, swaps };
	}

	function fixedState(): Promise<Fixed> {
		if (!fixed) {
			fixed = patiently(readFixed);
			fixed.catch(() => {
				fixed = undefined;
			});
		}
		return fixed;
	}

	function movingState(): Promise<Moving> {
		const now = Date.now();
		if (!moving || now - moving.at > FRESH_MS) {
			const value = patiently(readMoving);
			moving = { at: now, value };
			value.catch(() => {
				if (moving?.value === value) moving = undefined;
			});
		}
		return moving.value;
	}

	function conditionOf(
		m: Listed,
		state: MarketState,
		f: Fixed,
		s: Moving,
	): Condition {
		const key = `${m.eventKey}/${m.conditionKey}`;
		const seal = state.seal;
		if (!seal) throw new Error(`${key}: no seal`);
		const probability = s.slot0.get(m.probability.id.toLowerCase());
		const yesPool = s.slot0.get(m.yesPool.id.toLowerCase());
		const noPool = s.slot0.get(m.noPool.id.toLowerCase());
		if (!probability || !yesPool || !noPool)
			throw new Error(`${key}: no pools`);
		const yesDollar = yesDollarPrice(
			probability.sqrtPriceX96,
			m.probability.yesFirst,
		);
		const shareDecimals = f.shareDecimals.get(key) ?? 18;
		const dollarDecimals = f.dollarDecimals.get(key) ?? 6;
		const yesWorld = worldPriceCents(
			yesPool.sqrtPriceX96,
			m.yesPool.shareIsToken0,
			shareDecimals,
			dollarDecimals,
		);
		const noWorld = worldPriceCents(
			noPool.sqrtPriceX96,
			m.noPool.shareIsToken0,
			shareDecimals,
			dollarDecimals,
		);
		const { beat, dont, implied } = pans(yesWorld, noWorld, yesDollar);
		const primary =
			factsOf(m.eventKey).conditions.find((c) => c.key === m.conditionKey)
				?.primary ?? false;
		return {
			key: m.conditionKey,
			threshold: seal.value,
			decimals: seal.decimals,
			primary,
			chance: chanceOf(yesDollar),
			yesWorldPriceCents: yesWorld,
			noWorldPriceCents: noWorld,
			beatPriceCents: beat,
			dontPriceCents: dont,
			impliedCents: implied,
			feeBps: feeBpsOf(yesPool.lpFee),
			sealedAt: new Date(s.sealTimes.get(seal.sealBlock) ?? 0).toISOString(),
			sealTx: m.sealTx,
			market: m.binding,
			resolution: resolutionOf(state.resolution, state.outcome),
		};
	}

	async function allEvents(): Promise<MarketEvent[]> {
		const [f, s] = await Promise.all([fixedState(), movingState()]);
		const present = listed.filter((m) => s.markets.has(idOf(m)));
		const keys = [...new Set(present.map((m) => m.eventKey))];
		return keys.map((eventKey) => {
			const markets = present.filter((m) => m.eventKey === eventKey);
			const first = markets[0];
			if (!first) throw new Error(`${eventKey}: no markets`);
			const stateOf = (m: Listed) => s.markets.get(idOf(m)) as MarketState;
			const facts = factsOf(eventKey);
			const conditions = markets
				.map((m) => conditionOf(m, stateOf(m), f, s))
				.sort((a, b) => (a.threshold < b.threshold ? -1 : 1));
			const announcesAt = stateOf(first).seal?.announcesAt ?? 0n;
			const spot = s.spotCents.get(first.issuer);
			return {
				eventKey,
				issuer: first.issuer,
				period: facts.period,
				announcesAt: new Date(Number(announcesAt) * 1000)
					.toISOString()
					.replace(".000Z", "Z"),
				releaseTiming: facts.releaseTiming,
				dateConfirmed: facts.dateSource.confirmed,
				sector: facts.sector,
				moneyIn: markets.reduce(
					(sum, m) =>
						sum + centsOf(stateOf(m).dollarsIn, f.settlementDollarDecimals),
					0n,
				),
				spotCents: spot?.cents ?? 0n,
				spotPublishedAt: spot?.publishedAt ?? "",
				conditions,
			};
		});
	}

	return {
		events: () => allEvents(),
		event: async (eventKey) =>
			(await allEvents()).find((e) => e.eventKey === eventKey),
		history: async (eventKey, conditionKey, now) => {
			const m = listed.find(
				(x) => x.eventKey === eventKey && x.conditionKey === conditionKey,
			);
			if (!m) return { points: [], tradesKnown: false };
			const s = await movingState();
			const pool = m.probability.id.toLowerCase();
			// The trades are known only from the indexer; the chain alone gives the opening and now.
			const swaps = s.swaps?.filter((swap) => swap.pool === pool);
			const logs = await Promise.all([
				...(m.opened
					? [
							(async () => ({
								kind: "opened" as const,
								sqrtPriceX96: m.opened?.sqrtPriceX96 ?? 0n,
								at: await timeOf(m.block),
							}))(),
						]
					: []),
				...(swaps ?? []).map(async (swap) => ({
					kind: "trade" as const,
					sqrtPriceX96: swap.sqrtPriceX96,
					at: await timeOf(swap.block),
				})),
			]);
			return {
				points: historyOf(
					logs,
					m.probability.yesFirst,
					s.slot0.get(pool)?.sqrtPriceX96,
					now,
				),
				tradesKnown: swaps !== undefined,
			};
		},
		settlement: async () => (await fixedState()).settlement,
		warm: async () => {
			await allEvents();
		},
	};
}

/**
 * A probability pool's chance over time: where it opened, each trade, and where it stands now, every
 * point from a price the pool manager logged or holds.
 */
export function historyOf(
	logs: { kind: "opened" | "trade"; sqrtPriceX96: bigint; at: number }[],
	yesFirst: boolean,
	current: bigint | undefined,
	now: number,
): ChancePoint[] {
	const points: ChancePoint[] = logs.map((l) => ({
		at: l.at,
		chance: chanceOf(yesDollarPrice(l.sqrtPriceX96, yesFirst)),
		source: l.kind,
	}));
	if (current !== undefined)
		points.push({
			at: now,
			chance: chanceOf(yesDollarPrice(current, yesFirst)),
			source: "now",
		});
	return points;
}

/** A fetch that starts its requests at least `spacing` milliseconds apart. */
export function paced(inner: typeof fetch, spacing: number): typeof fetch {
	let nextAt = 0;
	return async (input, init) => {
		const now = Date.now();
		const at = Math.max(now, nextAt);
		nextAt = at + spacing;
		if (at > now) await new Promise((r) => setTimeout(r, at - now));
		return inner(input, init);
	};
}

let shared: ReadLayer | undefined;

/** The read layer for a record, one per server, so its readings are shared between requests. */
export function sharedChainLayer(book: Book): ReadLayer {
	if (!shared) {
		const client = createPublicClient({
			chain: TESTNET,
			transport: http(rpcUrl(), {
				retryCount: 6,
				retryDelay: 500,
				fetchFn: paced(fetch, REQUEST_SPACING_MS),
			}),
			batch: { multicall: true },
		}) as PublicClient;
		shared = chainLayer(book, client);
	}
	return shared;
}
