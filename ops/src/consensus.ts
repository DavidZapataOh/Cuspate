/**
 * The consensus re-read: right before an event is sealed, its consensus is read again from the source
 * the manifest names, and its thresholds move with it, keeping their step. A person reads the source;
 * this applies what they read the same way every time, and refuses an event already sealed.
 *
 *   node ops/src/consensus.ts                                   every event, its consensus and source
 *   node ops/src/consensus.ts set <eventKey> <value> <date>     record a re-read, e.g. 0.45 2026-10-20
 *
 * Run against the test network's manifest; CONSENSUS_CHAIN chooses another. A broadcast seals what the
 * manifest says at its commit, so a re-read is committed before the window's rehearsal.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { committedPath, readBook } from "./book.ts";
import { type EventEntry, loadEvents, openingChance } from "./events.ts";

const CENTS = /^\d+\.\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const cents = (text: string) => Math.round(Number(text) * 100);
const dollars = (value: number) => (value / 100).toFixed(2);

/** The event with its consensus read again: thresholds at C-m, C, C+m and C+2m, m unchanged. */
export function rebase(
	event: EventEntry,
	value: string,
	retrievedAt: string,
): EventEntry {
	if (!CENTS.test(value))
		throw new Error(
			`${value}: a consensus is written in dollars and cents, as 0.45`,
		);
	if (!DATE.test(retrievedAt))
		throw new Error(`${retrievedAt}: a date is written as YYYY-MM-DD`);
	const primary = event.conditions.findIndex((c) => c.primary);
	const above = event.conditions[primary + 1];
	if (primary < 0 || !above)
		throw new Error(
			`${event.eventKey} has no primary threshold with one above it`,
		);
	const step = cents(above.threshold) - cents(event.consensus.value);
	const consensus = cents(value);
	const conditions = event.conditions.map((_, i) => {
		const threshold = consensus + (i - primary) * step;
		return {
			key: `above-${dollars(threshold).replace(".", "-")}`,
			threshold: dollars(threshold),
			primary: i === primary,
			openingChance: openingChance(
				threshold / 100,
				consensus / 100,
				step / 100,
			),
		};
	});
	return {
		...event,
		consensus: { ...event.consensus, value, retrievedAt },
		conditions,
	};
}

/** Why an event's consensus may no longer move: any of its markets is recorded, so it is sealed. */
export function refuseRebase(
	event: EventEntry,
	book: { [key: string]: unknown },
): string | null {
	const markets = Object.values(
		(book.markets ?? {}) as Record<string, { eventKey: string }>,
	);
	return markets.some((m) => m.eventKey === event.eventKey)
		? `refusing: ${event.eventKey} is already sealed, and what is sealed cannot follow the consensus`
		: null;
}

function main(): void {
	const chainId = Number(process.env.CONSENSUS_CHAIN ?? 10143);
	const manifest = loadEvents(chainId);
	const [command, key, value, date] = process.argv.slice(2);
	if (!command) {
		for (const e of manifest.events)
			console.log(
				`${e.eventKey}\t${e.consensus.value} ${e.consensus.basis}\tread ${e.consensus.retrievedAt}\t${e.consensus.url}`,
			);
		return;
	}
	if (command !== "set" || !key || !value || !date)
		throw new Error("usage: consensus.ts [set <eventKey> <value> <date>]");
	const index = manifest.events.findIndex((e) => e.eventKey === key);
	const event = manifest.events[index];
	if (!event) throw new Error(`no event ${key}`);
	const refusal = refuseRebase(event, readBook(committedPath(chainId)));
	if (refusal) throw new Error(refusal);
	manifest.events[index] = rebase(event, value, date);
	const file = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"events",
		`${chainId}.json`,
	);
	writeFileSync(file, `${JSON.stringify(manifest, null, "\t")}\n`);
	console.log(
		`${key}: consensus ${value}, thresholds ${manifest.events[index]?.conditions.map((c) => c.threshold).join(", ")}`,
	);
}

if (
	process.argv[1] &&
	import.meta.url.endsWith(path.basename(process.argv[1]))
) {
	try {
		main();
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
}
