/**
 * The interface's read model: what the screens show about events, their conditions and how they
 * settle. Two sources fill it: synthetic fixtures today, and the indexer plus the chain once the
 * markets are live. Both give exactly these shapes, so the screens do not change between them.
 */

import type { Period } from "cuspate-shared";
import type { Address, Hex } from "viem";

/** A condition's market on chain: what a purchase names and the tokens it moves. */
export type MarketBinding = {
	marketId: Hex;
	/** The vault that turns dollars into a dollar in each world. */
	dollarVault: Address;
	/** Each world's share of the stock and each world's dollar. */
	legs: {
		underlyingYes: Address;
		underlyingNo: Address;
		dollarYes: Address;
		dollarNo: Address;
	};
};

/** One condition of an event: a sealed threshold and the market that trades it. */
export type Condition = {
	/** Stable within its event, for links and selection. */
	key: string;
	/** The sealed threshold, an integer at `decimals`: 43n at 2 decimals is $0.43. */
	threshold: bigint;
	decimals: number;
	/** The threshold set at the consensus estimate; one per event. */
	primary: boolean;
	/** The chance the pools imply that the reported figure is above the threshold. */
	chance: number;
	/** What one share costs in each world, in that world's dollars, in cents. */
	yesWorldPriceCents: bigint;
	noWorldPriceCents: bigint;
	/** What each world's share costs today in plain dollars: the two pans of the balance. */
	beatPriceCents: bigint;
	dontPriceCents: bigint;
	/** The share price the pools imply: the two pans added. */
	impliedCents: bigint;
	/** The pools' fee, in basis points. */
	feeBps: bigint;
	/** When the threshold was sealed, and in which transaction once it exists on chain. */
	sealedAt: string;
	sealTx?: string;
	/** Its market, once one is open on chain; until then the ticket only previews. */
	market?: MarketBinding;
};

/**
 * A company's scheduled earnings release and its conditions. The company's name, the figure that
 * settles it and how its quarter is named and dated are the issuer's own facts, read from the shared
 * profiles by ticker (see `about`), not carried here.
 */
export type MarketEvent = {
	/** In links: ticker, quarter and fiscal year, "msft-q1-2027". */
	eventKey: string;
	/** The ticker, upper case. */
	issuer: string;
	/** The quarter, in the issuer's own fiscal year. */
	period: Period;
	/** The announcement: trading freezes here. */
	announcesAt: string;
	releaseTiming: "before-open" | "after-close";
	/** Whether the company itself has published the date. */
	dateConfirmed: boolean;
	/** For the filter chips. */
	sector: string;
	/** Dollars in the event's dollar vaults, in cents, our own seeded liquidity included. */
	moneyIn: bigint;
	/** The feed's price of the stock, in cents. */
	spotCents: bigint;
	conditions: Condition[];
};

/** One point of a condition's chance over time. */
export type ChancePoint = { at: number; chance: number };

/** How every market of a deployment settles. */
export type Settlement = {
	network: string;
	/** How long a proposed figure can be challenged. */
	livenessSeconds: number;
	/** How long the arbiter has to rule on a challenge. */
	arbiterTimeoutSeconds: number;
	/** How long after the deadline an unsettled event resolves invalid. */
	expirySeconds: number;
	/** What a proposer puts down, in cents of the settlement dollar. */
	bondCents: bigint;
	arbiter: string;
	guardian: string;
};

/** Where the screens read from. */
export type ReadLayer = {
	/** True while the data is made up: the screens say so. */
	synthetic: boolean;
	events(now: number): Promise<MarketEvent[]>;
	event(eventKey: string, now: number): Promise<MarketEvent | undefined>;
	history(
		eventKey: string,
		conditionKey: string,
		now: number,
	): Promise<ChancePoint[]>;
	settlement(): Promise<Settlement>;
};
