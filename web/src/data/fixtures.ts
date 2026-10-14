/**
 * SYNTHETIC DATA. Made-up prices, chances, histories and money in, shaped exactly like what the
 * indexer and the chain will provide, so the screens can be built and tested before the markets
 * are live. The events themselves (companies, periods, figures, announcement times and thresholds)
 * follow the test network's event manifest; every number that would come from trading is invented
 * here, and the interface says so on every page while this source is in use.
 */
import type {
	ChancePoint,
	Condition,
	MarketEvent,
	ReadLayer,
	Settlement,
} from "./model.ts";

type Seed = {
	issuer: string;
	period: MarketEvent["period"];
	announcesAt: string;
	releaseTiming: MarketEvent["releaseTiming"];
	dateConfirmed: boolean;
	sector: string;
	/** Thresholds in cents: consensus - m, consensus (primary), + m, + 2m. */
	thresholds: [number, number, number, number];
	/** Synthetic: the stock's price in cents, the primary condition's chance, test dollars in. */
	spotCents: number;
	primaryChance: number;
	moneyInDollars: number;
};

const SEEDS: Seed[] = [
	{
		issuer: "TSLA",
		period: {
			quarter: 3,
			fiscalYear: 2026,
		},
		announcesAt: "2026-10-21T20:00:00Z",
		releaseTiming: "after-close",
		dateConfirmed: true,
		sector: "auto",
		thresholds: [38, 43, 48, 53],
		spotCents: 37_540,
		primaryChance: 0.62,
		moneyInDollars: 12_400,
	},
	{
		issuer: "META",
		period: {
			quarter: 3,
			fiscalYear: 2026,
		},
		announcesAt: "2026-10-21T20:00:00Z",
		releaseTiming: "after-close",
		dateConfirmed: true,
		sector: "tech",
		thresholds: [551, 639, 727, 815],
		spotCents: 76_120,
		primaryChance: 0.66,
		moneyInDollars: 18_700,
	},
	{
		issuer: "HOOD",
		period: {
			quarter: 3,
			fiscalYear: 2026,
		},
		announcesAt: "2026-10-27T20:00:00Z",
		releaseTiming: "after-close",
		dateConfirmed: true,
		sector: "finance",
		thresholds: [47, 55, 63, 71],
		spotCents: 11_130,
		primaryChance: 0.58,
		moneyInDollars: 6_300,
	},
	{
		issuer: "MSFT",
		period: {
			quarter: 1,
			fiscalYear: 2027,
		},
		announcesAt: "2026-10-28T20:00:00Z",
		releaseTiming: "after-close",
		dateConfirmed: true,
		sector: "tech",
		thresholds: [445, 471, 497, 523],
		spotCents: 54_610,
		primaryChance: 0.77,
		moneyInDollars: 22_100,
	},
	{
		issuer: "GOOGL",
		period: {
			quarter: 3,
			fiscalYear: 2026,
		},
		announcesAt: "2026-10-28T20:00:00Z",
		releaseTiming: "after-close",
		dateConfirmed: true,
		sector: "tech",
		thresholds: [249, 294, 339, 384],
		spotCents: 35_420,
		primaryChance: 0.71,
		moneyInDollars: 16_800,
	},
	{
		issuer: "AAPL",
		period: {
			quarter: 4,
			fiscalYear: 2026,
		},
		announcesAt: "2026-11-02T21:00:00Z",
		releaseTiming: "after-close",
		dateConfirmed: true,
		sector: "tech",
		thresholds: [188, 199, 210, 221],
		spotCents: 34_480,
		primaryChance: 0.69,
		moneyInDollars: 31_400,
	},
	{
		issuer: "AMD",
		period: {
			quarter: 3,
			fiscalYear: 2026,
		},
		announcesAt: "2026-11-03T21:00:00Z",
		releaseTiming: "after-close",
		dateConfirmed: true,
		sector: "tech",
		thresholds: [180, 192, 204, 216],
		spotCents: 61_950,
		primaryChance: 0.55,
		moneyInDollars: 9_600,
	},
	{
		issuer: "NVDA",
		period: {
			quarter: 3,
			fiscalYear: 2027,
		},
		announcesAt: "2026-11-18T21:00:00Z",
		releaseTiming: "after-close",
		dateConfirmed: false,
		sector: "tech",
		thresholds: [241, 247, 253, 259],
		spotCents: 22_680,
		primaryChance: 0.81,
		moneyInDollars: 45_200,
	},
	{
		issuer: "WMT",
		period: {
			quarter: 3,
			fiscalYear: 2027,
		},
		announcesAt: "2026-11-19T13:00:00Z",
		releaseTiming: "before-open",
		dateConfirmed: true,
		sector: "retail",
		thresholds: [60, 63, 66, 69],
		spotCents: 11_290,
		primaryChance: 0.62,
		moneyInDollars: 7_800,
	},
	{
		issuer: "MU",
		period: {
			quarter: 1,
			fiscalYear: 2027,
		},
		announcesAt: "2026-12-16T21:00:00Z",
		releaseTiming: "after-close",
		dateConfirmed: false,
		sector: "tech",
		thresholds: [3_760, 3_820, 3_880, 3_940],
		spotCents: 94_140,
		primaryChance: 0.66,
		moneyInDollars: 5_900,
	},
];

/** A small seeded generator, so the synthetic histories are the same on every render. */
function generator(seed: string) {
	let state = [...seed].reduce(
		(h, c) => Math.imul(h ^ c.charCodeAt(0), 2_654_435_761) >>> 0,
		2_166_136_261,
	);
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const round = (n: number) => BigInt(Math.round(n));
/** Chances of the four thresholds, falling as the threshold rises. */
const OFFSETS = [0.17, 0, -0.2, -0.38];

function condition(seed: Seed, index: number): Condition {
	const chance = Math.min(
		0.97,
		Math.max(0.03, seed.primaryChance + (OFFSETS[index] ?? 0)),
	);
	// The yes world prices the stock a little higher than the feed, the no world a little lower, so
	// that the two worlds weighted by the chance come back to the feed's price.
	const tilt = 0.04;
	const yesWorld = seed.spotCents * (1 + tilt * (1 - chance));
	const noWorld = seed.spotCents * (1 - tilt * chance);
	const beat = round(chance * yesWorld);
	const dont = round((1 - chance) * noWorld);
	const threshold = seed.thresholds[index] ?? 0;
	return {
		key: `above-${Math.floor(threshold / 100)}-${String(threshold % 100).padStart(2, "0")}`,
		threshold: BigInt(threshold),
		decimals: 2,
		primary: index === 1,
		chance: Math.round(chance * 100) / 100,
		yesWorldPriceCents: round(yesWorld),
		noWorldPriceCents: round(noWorld),
		beatPriceCents: beat,
		dontPriceCents: dont,
		impliedCents: beat + dont,
		feeBps: 30n,
		sealedAt: "2026-10-14T09:00:00Z",
	};
}

function toEvent(seed: Seed): MarketEvent {
	return {
		eventKey: `${seed.issuer.toLowerCase()}-q${seed.period.quarter}-${seed.period.fiscalYear}`,
		issuer: seed.issuer,
		period: seed.period,
		announcesAt: seed.announcesAt,
		releaseTiming: seed.releaseTiming,
		dateConfirmed: seed.dateConfirmed,
		sector: seed.sector,
		moneyIn: BigInt(seed.moneyInDollars) * 100n,
		spotCents: BigInt(seed.spotCents),
		conditions: [0, 1, 2, 3].map((i) => condition(seed, i)),
	};
}

const EVENTS = SEEDS.map(toEvent);
const HOUR = 3_600_000;

/** Hourly points over the last two weeks, a random walk that ends at the condition's chance. */
function history(event: MarketEvent, c: Condition, now: number): ChancePoint[] {
	const random = generator(`${event.eventKey}/${c.key}`);
	const end = Math.min(now, Date.parse(event.announcesAt));
	const last = Math.floor(end / HOUR) * HOUR;
	const points: ChancePoint[] = [{ at: last, chance: c.chance }];
	let logit = Math.log(c.chance / (1 - c.chance));
	for (let i = 1; i < 14 * 24; i++) {
		logit += (random() - 0.5) * 0.12;
		const chance = 1 / (1 + Math.exp(-logit));
		points.unshift({
			at: last - i * HOUR,
			chance: Math.round(chance * 1000) / 1000,
		});
	}
	return points;
}

/** The test network's settlement parameters and role accounts, as deployed. */
const SETTLEMENT: Settlement = {
	network: "Monad testnet",
	livenessSeconds: 600,
	arbiterTimeoutSeconds: 7_200,
	expirySeconds: 86_400,
	bondCents: 1_000n,
	arbiter: "0xCf855Ea701f50f8889e095d454737C6ED25fb873",
	guardian: "0x50b4aABa9e58270EfaBD089B980d9bDE9E85e698",
};

/** The synthetic read layer. */
export const fixtures: ReadLayer = {
	synthetic: true,
	events: async () => EVENTS,
	event: async (eventKey) => EVENTS.find((e) => e.eventKey === eventKey),
	history: async (eventKey, conditionKey, now) => {
		const event = EVENTS.find((e) => e.eventKey === eventKey);
		const c = event?.conditions.find((x) => x.key === conditionKey);
		return event && c ? history(event, c, now) : [];
	},
	settlement: async () => SETTLEMENT,
};
