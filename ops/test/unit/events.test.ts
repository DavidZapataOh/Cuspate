import { issuer, renderTerms } from "cuspate-shared";
import { describe, expect, test } from "vitest";
import {
	closeOf,
	due,
	type EventEntry,
	loadEvents,
	openingChance,
	thresholdOf,
} from "../../src/events.ts";

const manifest = loadEvents(10143);

describe("the test network's event manifest", () => {
	test("lists the ten issuers, four conditions each", () => {
		expect(manifest.events.map((e) => e.issuer).sort()).toEqual(
			[
				"AAPL",
				"AMD",
				"GOOGL",
				"HOOD",
				"META",
				"MSFT",
				"MU",
				"NVDA",
				"TSLA",
				"WMT",
			].sort(),
		);
		for (const e of manifest.events) expect(e.conditions).toHaveLength(4);
	});

	test("seals exactly what the shared renderer produces, within its bound", () => {
		for (const e of manifest.events) {
			const t = thresholdOf(e, e.conditions[0]);
			const text = Buffer.from(t.terms.slice(2), "hex").toString("utf8");
			expect(text).toBe(
				renderTerms(issuer(e.issuer), {
					period: e.period,
					fallback: e.fallback,
					fallbackFrom: e.fallbackFrom,
				}),
			);
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(600);
		}
	});

	test("every condition's threshold is its cents at two decimals, the primary at the consensus", () => {
		for (const e of manifest.events) {
			const primaries = e.conditions.filter((c) => c.primary);
			expect(primaries).toHaveLength(1);
			expect(primaries[0]?.threshold).toBe(e.consensus.value);
			const t = thresholdOf(e, primaries[0] as EventEntry["conditions"][0]);
			expect(t.decimals).toBe(2);
			expect(t.value).toBe(BigInt(Math.round(Number(e.consensus.value) * 100)));
		}
	});

	test("thresholds rise and opening chances fall across an event's conditions", () => {
		for (const e of manifest.events) {
			const values = e.conditions.map((c) => Number(c.threshold));
			const chances = e.conditions.map((c) => Number(c.openingChance));
			expect([...values].sort((a, b) => a - b)).toEqual(values);
			for (let i = 1; i < chances.length; i++)
				expect(chances[i]).toBeLessThan(chances[i - 1] as number);
			for (const p of chances) {
				expect(p).toBeGreaterThan(0);
				expect(p).toBeLessThan(1);
			}
		}
	});

	test("opening chances follow the written rule", () => {
		for (const e of manifest.events) {
			const m = Number(e.conditions[2]?.threshold) - Number(e.consensus.value);
			for (const c of e.conditions)
				expect(c.openingChance).toBe(
					openingChance(Number(c.threshold), Number(e.consensus.value), m),
				);
		}
		expect(openingChance(1, 1, 0.1)).toBe("0.50");
		expect(openingChance(0.9, 1, 0.1)).toBe("0.75");
		expect(openingChance(1.1, 1, 0.1)).toBe("0.25");
	});

	test("the announcement is the market close in New York, or the morning release for a before-open issuer", () => {
		expect(closeOf("2026-10-21", "after-close")).toBe("2026-10-21T20:00:00Z");
		expect(closeOf("2026-11-02", "after-close")).toBe("2026-11-02T21:00:00Z");
		expect(closeOf("2026-11-19", "before-open")).toBe("2026-11-19T13:00:00Z");
		for (const e of manifest.events)
			expect(e.announcesAt).toBe(
				closeOf(e.announcesAt.slice(0, 10), e.releaseTiming),
			);
	});

	test("an event whose date the issuer has not confirmed is never due for sealing", () => {
		const unconfirmed = manifest.events.filter((e) => !e.dateSource.confirmed);
		expect(unconfirmed.map((e) => e.issuer).sort()).toEqual(["MU", "NVDA"]);
		const all = due(manifest, "2026-10-14T00:00:00Z", "2027-01-31T00:00:00Z");
		for (const e of unconfirmed) expect(all).not.toContain(e);
	});

	test("the first batch is Tesla and Meta, earliest announcement first, then by key", () => {
		const first = due(manifest, "2026-10-14T00:00:00Z", "2026-10-22T00:00:00Z");
		expect(first.map((e) => e.issuer)).toEqual(["META", "TSLA"]);
		const second = due(
			manifest,
			"2026-10-22T00:00:00Z",
			"2026-10-29T00:00:00Z",
		);
		expect(second.map((e) => e.issuer)).toEqual(["HOOD", "GOOGL", "MSFT"]);
	});

	test("event keys are unique slugs and every event names its stock and sources", () => {
		const keys = manifest.events.map((e) => e.eventKey);
		expect(new Set(keys).size).toBe(keys.length);
		for (const e of manifest.events) {
			expect(e.eventKey).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(e.stock).toBe(`TestnetStock.${e.issuer}`);
			expect(e.consensus.url).toMatch(/^https:\/\//);
			expect(e.dateSource.url).toMatch(/^https:\/\//);
			expect(Date.parse(e.deadline)).toBeGreaterThan(Date.parse(e.announcesAt));
		}
	});
});
