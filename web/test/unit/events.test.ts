import assert from "node:assert/strict";
import { test } from "node:test";
import { filterEvents, pickFeatured } from "../../src/lib/events.ts";

type E = Parameters<typeof pickFeatured>[0][number];
const base = { sector: "tech", conditions: [] } as unknown as E;
function event(
	key: string,
	announcesAt: string,
	moneyIn: bigint,
	extra: Partial<E> = {},
): E {
	return {
		...base,
		eventKey: key,
		issuer: key.toUpperCase(),
		announcesAt,
		moneyIn,
		...extra,
	} as E;
}
const now = Date.parse("2026-10-14T12:00:00Z");

test("the featured event is the next one to freeze, ignoring frozen ones", () => {
	const events = [
		event("aapl", "2026-11-02T21:00:00Z", 10n),
		event("past", "2026-10-13T20:00:00Z", 999n),
		event("msft", "2026-10-28T20:00:00Z", 10n),
	];
	assert.equal(pickFeatured(events, now)?.eventKey, "msft");
});

test("when several share the next freeze, the one with more money in leads, then the ticker", () => {
	const events = [
		event("tsla", "2026-10-21T20:00:00Z", 100n),
		event("meta", "2026-10-21T20:00:00Z", 300n),
	];
	assert.equal(pickFeatured(events, now)?.eventKey, "meta");
	const even = [
		event("tsla", "2026-10-21T20:00:00Z", 1n),
		event("meta", "2026-10-21T20:00:00Z", 1n),
	];
	assert.equal(pickFeatured(even, now)?.eventKey, "meta");
});

test("with nothing open there is no featured event", () => {
	assert.equal(
		pickFeatured([event("past", "2026-10-01T20:00:00Z", 1n)], now),
		undefined,
	);
});

test("filters narrow the open events and search matches company or ticker", () => {
	const events = [
		event("tsla", "2026-10-21T20:00:00Z", 1n, { sector: "auto" }),
		event("msft", "2026-10-28T20:00:00Z", 1n),
		event("aapl", "2026-11-02T21:00:00Z", 1n),
		event("past", "2026-10-01T20:00:00Z", 1n, { issuer: "HOOD" }),
	];
	const keys = (list: E[]) => list.map((e) => e.eventKey);
	// Two days later, Tesla is inside the week and Apple inside the three weeks of "ending soon".
	const later = Date.parse("2026-10-16T12:00:00Z");
	assert.deepEqual(keys(filterEvents(events, "All", "", now)), [
		"tsla",
		"msft",
		"aapl",
	]);
	assert.deepEqual(keys(filterEvents(events, "This week", "", later)), [
		"tsla",
	]);
	assert.deepEqual(keys(filterEvents(events, "Tech", "", now)), [
		"msft",
		"aapl",
	]);
	assert.deepEqual(keys(filterEvents(events, "Ending soon", "", later)), [
		"tsla",
		"msft",
		"aapl",
	]);
	// The company's name is the shared profile's: "Microsoft" for MSFT.
	assert.deepEqual(keys(filterEvents(events, "All", "micro", now)), ["msft"]);
	assert.deepEqual(keys(filterEvents(events, "All", "AAPL", now)), ["aapl"]);
});
