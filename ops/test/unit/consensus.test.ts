import { describe, expect, test } from "vitest";
import { rebase, refuseRebase } from "../../src/consensus.ts";
import { loadEvents } from "../../src/events.ts";

const manifest = loadEvents(10143);
const tsla = manifest.events.find((e) => e.eventKey === "tsla-q3-2026");
if (!tsla) throw new Error("no TSLA event");

describe("re-reading an event's consensus", () => {
	test("moves the thresholds with it, keeping the step, and recomputes their opening chances", () => {
		const moved = rebase(tsla, "0.45", "2026-10-20");
		expect(moved.consensus.value).toBe("0.45");
		expect(moved.consensus.retrievedAt).toBe("2026-10-20");
		expect(moved.conditions).toEqual([
			{
				key: "above-0-40",
				threshold: "0.40",
				primary: false,
				openingChance: "0.75",
			},
			{
				key: "above-0-45",
				threshold: "0.45",
				primary: true,
				openingChance: "0.50",
			},
			{
				key: "above-0-50",
				threshold: "0.50",
				primary: false,
				openingChance: "0.25",
			},
			{
				key: "above-0-55",
				threshold: "0.55",
				primary: false,
				openingChance: "0.10",
			},
		]);
		expect(moved.consensus.url).toBe(tsla.consensus.url);
	});

	test("an unchanged consensus changes only the date it was read", () => {
		const same = rebase(tsla, tsla.consensus.value, "2026-10-20");
		expect(same.conditions).toEqual(tsla.conditions);
	});

	test("refuses malformed values and dates", () => {
		expect(() => rebase(tsla, "0.4", "2026-10-20")).toThrow(/cents/);
		expect(() => rebase(tsla, "0.45", "20 Oct")).toThrow(/date/);
	});

	test("refuses an event already sealed: what is sealed cannot follow the consensus", () => {
		expect(
			refuseRebase(tsla, {
				markets: { "tsla-q3-2026/above-0-38": { eventKey: "tsla-q3-2026" } },
			}),
		).toMatch(/sealed/);
		expect(
			refuseRebase(tsla, {
				markets: { "meta-q3-2026/above-5-51": { eventKey: "meta-q3-2026" } },
			}),
		).toBeNull();
	});
});
