/**
 * The events a network lists, as a person writes them in `ops/events/<chain>.json`: one earnings
 * announcement per issuer, several thresholds each. Every threshold is sealed as its own event with the
 * terms the shared renderer produces, so the sealing tool, the resolution workflow and the interface
 * read the same text.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { issuer, type Period, renderTerms } from "cuspate-shared";
import { type Hex, toHex } from "viem";

/** Whether an issuer reports after the close or before the open. */
export type ReleaseTiming = "after-close" | "before-open";

/** One threshold of an event, sealed as its own event and traded as its own market. */
export type Condition = {
	/** Stable within its event; the interface addresses the condition by it. */
	key: string;
	/** In dollars per share, two decimals, as text. */
	threshold: string;
	/** The one condition whose threshold is the consensus. */
	primary: boolean;
	/** The yes-dollar's opening price, from the written rule. */
	openingChance: string;
};

export type EventEntry = {
	eventKey: string;
	issuer: string;
	displayName: string;
	period: Period;
	announcesAt: string;
	releaseTiming: ReleaseTiming;
	deadline: string;
	fallback: string;
	fallbackFrom: string;
	dateSource: { url: string; confirmed: boolean };
	sector: string;
	/** The record's key for the event's stock on this network. */
	stock: string;
	consensus: {
		value: string;
		basis: string;
		source: string;
		url: string;
		retrievedAt: string;
	};
	conditions: Condition[];
};

export type EventManifest = {
	network: number;
	rules: Record<string, string>;
	seeding: {
		dollarsPerMarket: string;
		dollarCap: string;
		shareCapValue: string;
		halfWidthTicks: number;
	};
	events: EventEntry[];
};

const here = path.dirname(fileURLToPath(import.meta.url));

/** A network's manifest, checked as it is read. */
export function loadEvents(chainId: number): EventManifest {
	const file = path.join(here, "..", "events", `${chainId}.json`);
	const manifest = JSON.parse(readFileSync(file, "utf8")) as EventManifest;
	if (manifest.network !== chainId)
		throw new Error(`${file} is not the manifest of chain ${chainId}`);
	return manifest;
}

/** Seconds since the epoch of an ISO instant. */
function seconds(iso: string): bigint {
	return BigInt(Date.parse(iso) / 1000);
}

/** The threshold struct the registry seals for one condition of an event. */
export function thresholdOf(event: EventEntry, condition: Condition) {
	const terms = renderTerms(issuer(event.issuer), {
		period: event.period,
		fallback: event.fallback,
		fallbackFrom: event.fallbackFrom,
	});
	const [whole, fraction = ""] = condition.threshold.split(".");
	if (fraction.length !== 2)
		throw new Error(`${event.eventKey}: a threshold has two decimals`);
	return {
		value: BigInt(`${whole}${fraction}`),
		decimals: 2,
		announcesAt: seconds(event.announcesAt),
		deadline: seconds(event.deadline),
		terms: toHex(terms) as Hex,
	};
}

/**
 * The opening chance of a threshold `k` steps of the issuer's typical surprise above the consensus:
 * one half at the consensus, falling as the threshold rises, kept off the extremes.
 */
export function openingChance(
	threshold: number,
	consensus: number,
	step: number,
): string {
	const k = (threshold - consensus) / step;
	const p = Math.min(0.95, Math.max(0.05, 1 / (1 + Math.exp(1.1 * k))));
	return p.toFixed(2);
}

/** Minutes east of UTC in New York at noon UTC of a date. */
function newYorkOffset(date: string): number {
	const noon = new Date(`${date}T12:00:00Z`);
	const local = new Date(
		noon.toLocaleString("en-US", { timeZone: "America/New_York" }),
	);
	const utc = new Date(noon.toLocaleString("en-US", { timeZone: "UTC" }));
	return Math.round((local.getTime() - utc.getTime()) / 60_000);
}

/**
 * The instant an issuer's announcement freezes its markets: the close in New York for an after-close
 * issuer, eight in the morning there for a before-open one.
 */
export function closeOf(date: string, timing: ReleaseTiming): string {
	const hour = timing === "after-close" ? 16 : 8;
	const utc =
		Date.parse(`${date}T00:00:00Z`) +
		(hour * 60 - newYorkOffset(date)) * 60_000;
	return `${new Date(utc).toISOString().slice(0, 19)}Z`;
}

/**
 * The events to seal in a window: confirmed dates only, announced in `[from, to)`, earliest first and
 * then by key, so the events closest to their announcement are sealed first.
 */
export function due(
	manifest: EventManifest,
	from: string,
	to: string,
): EventEntry[] {
	const start = Date.parse(from);
	const end = Date.parse(to);
	return manifest.events
		.filter((e) => e.dateSource.confirmed)
		.filter((e) => {
			const at = Date.parse(e.announcesAt);
			return at >= start && at < end;
		})
		.sort(
			(a, b) =>
				Date.parse(a.announcesAt) - Date.parse(b.announcesAt) ||
				a.eventKey.localeCompare(b.eventKey),
		);
}
