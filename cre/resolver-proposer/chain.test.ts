import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, toHex } from "viem";
import { type EventView, encodeReport, notBeforeOf, screen } from "./chain";

const RECEIVER = "0x00000000000000000000000000000000000000c1";
const SEALER = "0x00000000000000000000000000000000000000a1";
const EVENT = `0x${"ab".repeat(32)}` as const;
const TERMS = "earnings per share, diluted, non-GAAP, as first published";
const NOBODY = "0x0000000000000000000000000000000000000000";
// 2026-12-17T21:00:00Z, an announcement after the close in New York.
const ANNOUNCES_AT = 1797541200n;

const view: EventView = {
	sealer: SEALER,
	trustedSealer: SEALER,
	decimals: 2,
	announcesAt: ANNOUNCES_AT,
	terms: toHex(TERMS),
	round: 0,
	pendingArbitration: false,
	openProposer: NOBODY,
	firstProposer: NOBODY,
};
const config = {
	receiver: RECEIVER,
	terms: TERMS,
	announcesAt: ANNOUNCES_AT,
} as const;
const after = new Date(Number(ANNOUNCES_AT) * 1000 + 60_000);

describe("screen", () => {
	test("lets a sealed, open event with the configured terms be read, at the sealed decimals", () => {
		expect(screen(view, config, after)).toEqual({
			decimals: 2,
			notBefore: "2026-12-16",
		});
	});

	test("abstains when the chain's announcement is not the one the configuration was written for", () => {
		expect(
			screen(view, { ...config, announcesAt: ANNOUNCES_AT + 3600n }, after),
		).toEqual({ abstain: "terms-mismatch" });
	});

	test("abstains for an event the resolver's sealer did not seal", () => {
		expect(screen({ ...view, sealer: NOBODY }, config, after)).toEqual({
			abstain: "not-sealed",
		});
	});

	test("abstains unless the sealed terms are the configured terms, byte for byte", () => {
		expect(
			screen({ ...view, terms: toHex(`${TERMS} `) }, config, after),
		).toEqual({ abstain: "terms-mismatch" });
		expect(
			screen(view, { ...config, terms: TERMS.toUpperCase() }, after),
		).toEqual({ abstain: "terms-mismatch" });
	});

	test("abstains before the figure can be public", () => {
		const before = new Date(Number(ANNOUNCES_AT) * 1000 - 1000);
		expect(screen(view, config, before)).toEqual({ abstain: "too-early" });
		expect(screen(view, config, new Date(Number(ANNOUNCES_AT) * 1000))).toEqual(
			{
				decimals: 2,
				notBefore: "2026-12-16",
			},
		);
	});

	test("abstains when the open round already has a proposal", () => {
		const proposed = {
			...view,
			openProposer: "0x00000000000000000000000000000000000000d1",
		} as const;
		expect(screen(proposed, config, after)).toEqual({ abstain: "proposed" });
	});

	test("abstains while the event waits for the arbiter", () => {
		expect(
			screen({ ...view, round: 1, pendingArbitration: true }, config, after),
		).toEqual({ abstain: "arbitration" });
	});

	test("abstains from the second round after its own disputed proposal, and only its own", () => {
		expect(
			screen({ ...view, round: 1, firstProposer: RECEIVER }, config, after),
		).toEqual({ abstain: "own-disputed" });
		const someoneElse = {
			...view,
			round: 1,
			firstProposer: "0x00000000000000000000000000000000000000d1",
		} as const;
		expect(screen(someoneElse, config, after)).toEqual({
			decimals: 2,
			notBefore: "2026-12-16",
		});
	});

	test("compares addresses whatever their letter case", () => {
		const mixed = {
			...view,
			round: 1,
			firstProposer: RECEIVER.toUpperCase().replace("0X", "0x"),
		} as EventView;
		expect(
			screen(
				mixed,
				{ ...config, receiver: "0x00000000000000000000000000000000000000C1" },
				after,
			),
		).toEqual({
			abstain: "own-disputed",
		});
	});
});

describe("notBeforeOf", () => {
	test("is the UTC date the day before the announcement, so no Eastern filing date precedes it", () => {
		expect(notBeforeOf(ANNOUNCES_AT)).toBe("2026-12-16");
		// 03:00 UTC on 2026-12-18 is still 2026-12-17 in New York.
		expect(notBeforeOf(1797562800n)).toBe("2026-12-17");
	});
});

describe("encodeReport", () => {
	test("is the event, the figure and its decimals, as the receiver decodes them", () => {
		const report = encodeReport(EVENT, {
			text: "-1.31",
			value: -131n,
			decimals: 2,
		});
		expect(
			decodeAbiParameters(
				[{ type: "bytes32" }, { type: "int256" }, { type: "uint8" }],
				report,
			),
		).toEqual([EVENT, -131n, 2]);
	});
});
