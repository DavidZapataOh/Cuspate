import assert from "node:assert/strict";
import { test } from "node:test";
import { ISSUERS } from "cuspate-shared";
import { fixtures } from "../../src/data/fixtures.ts";

const now = Date.parse("2026-10-14T12:00:00Z");

test("the fixtures carry every event of the manifest, each with one primary condition among four", async () => {
	const events = await fixtures.events(now);
	assert.equal(events.length, 10);
	for (const event of events) {
		assert.equal(event.conditions.length, 4, event.eventKey);
		assert.equal(
			event.conditions.filter((c) => c.primary).length,
			1,
			event.eventKey,
		);
	}
});

test("every condition's two worlds add up to the price its pools imply, and its chance is open", async () => {
	for (const event of await fixtures.events(now)) {
		for (const c of event.conditions) {
			assert.ok(c.chance > 0 && c.chance < 1, `${event.eventKey} ${c.key}`);
			assert.equal(
				c.beatPriceCents + c.dontPriceCents,
				c.impliedCents,
				`${event.eventKey} ${c.key}`,
			);
			assert.ok(c.yesWorldPriceCents > 0n);
		}
	}
});

test("higher thresholds are less likely", async () => {
	for (const event of await fixtures.events(now)) {
		const chances = [...event.conditions]
			.sort((a, b) => Number(a.threshold - b.threshold))
			.map((c) => c.chance);
		for (let i = 1; i < chances.length; i++) {
			assert.ok((chances[i] ?? 1) < (chances[i - 1] ?? 0), event.eventKey);
		}
	}
});

test("a condition's chance history is in time order and ends at its chance", async () => {
	const [event] = await fixtures.events(now);
	const condition = event?.conditions[0];
	assert.ok(event && condition);
	const history = await fixtures.history(event.eventKey, condition.key, now);
	assert.ok(history.length > 10);
	const times = history.map((p) => p.at);
	for (let i = 1; i < times.length; i++)
		assert.ok((times[i] ?? 0) > (times[i - 1] ?? 0));
	assert.equal(history.at(-1)?.chance, condition.chance);
});

test("the fixtures say they are synthetic", () => {
	assert.equal(fixtures.synthetic, true);
});

test("each fixture event is one listed issuer's quarter, keyed by ticker, quarter and fiscal year", async () => {
	const events = await fixtures.events(now);
	assert.deepEqual(
		events.map((e) => e.issuer).sort(),
		ISSUERS.map((p) => p.ticker).sort(),
	);
	for (const event of events) {
		assert.equal(
			event.eventKey,
			`${event.issuer.toLowerCase()}-q${event.period.quarter}-${event.period.fiscalYear}`,
		);
		assert.deepEqual(Object.keys(event.period).sort(), [
			"fiscalYear",
			"quarter",
		]);
		assert.equal(
			"company" in event || "figureKind" in event,
			false,
			event.eventKey,
		);
	}
});

test("a condition's key is the record's: its threshold in dollars and cents", async () => {
	const meta = (await fixtures.events(now)).find((e) => e.issuer === "META");
	assert.deepEqual(
		meta?.conditions.map((c) => c.key),
		["above-5-51", "above-6-39", "above-7-27", "above-8-15"],
	);
	const tesla = (await fixtures.events(now)).find((e) => e.issuer === "TSLA");
	assert.equal(tesla?.conditions[1]?.key, "above-0-43");
});
