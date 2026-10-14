import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringToHex } from "viem";
import { describe, expect, test } from "vitest";
import { type Book, committedPath, readBook } from "../../src/book.ts";
import { loadEvents } from "../../src/events.ts";
import {
	creConfig,
	indexerConfig,
	keeperMarkets,
	writeGenerated,
} from "../../src/services.ts";

const book = readBook(committedPath(10143));
const manifest = loadEvents(10143);
const base = readFileSync(
	path.resolve(import.meta.dirname, "../../../indexer/config.yaml"),
	"utf8",
);
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const withMarkets: Book = {
	...book,
	markets: {
		"tsla-q3-2026/above-0-38": {
			eventKey: "tsla-q3-2026",
			issuer: "TSLA",
			eventId: id(1),
			marketId: id(11),
			block: 80_000_100,
		},
		"tsla-q3-2026/above-0-43": {
			eventKey: "tsla-q3-2026",
			issuer: "TSLA",
			eventId: id(2),
			marketId: id(12),
			block: 80_000_100,
		},
		"meta-q3-2026/above-5-51": {
			eventKey: "meta-q3-2026",
			issuer: "META",
			eventId: id(3),
			marketId: id(13),
			block: 80_000_050,
		},
	},
};

describe("the indexer's configuration for a network", () => {
	const yaml = indexerConfig(base, book, 10143);

	test("indexes the network's own deployment from its first block, through HyperSync", () => {
		expect(yaml).toContain("  - id: 10143\n");
		const first = Math.min(
			...[
				"MarketFactory",
				"ThresholdRegistry",
				"OptimisticResolver",
				"FreezeHook",
				"PositionRouter",
			].map((k) => (book[k] as { block: number }).block),
		);
		expect(yaml).toContain(`    start_block: ${first}\n`);
		expect(yaml).not.toMatch(/rpc:|for: sync|CUSPATE_RPC_URL/);
		expect(yaml).toContain(
			'address: "0x451D64ab3b650040d2aE1886602b97ed6eDc643d"',
		);
		expect(yaml).toContain(
			`address: "${(book.MarketFactory as { address: string }).address}"`,
		);
	});

	test("keeps the contracts and their events exactly as the base configuration lists them", () => {
		const contracts = base.slice(
			base.indexOf("name:"),
			base.indexOf("chains:"),
		);
		expect(yaml).toContain(contracts);
		expect(yaml.startsWith("# Generated from chain 10143's record")).toBe(true);
	});

	test("reads a rehearsal fork through its endpoint instead, from a block given", () => {
		const fork = indexerConfig(base, book, 10143, {
			url: "http://127.0.0.1:9999",
			startBlock: 123,
		});
		expect(fork).toContain("    start_block: 123\n");
		expect(fork).toContain(
			"      url: http://127.0.0.1:9999\n      for: sync\n",
		);
	});
});

describe("the keeper's markets for a network", () => {
	test("every recorded market, with its event and the symbol it is priced by", () => {
		expect(keeperMarkets(withMarkets, 10143)).toEqual({
			chainId: 10143,
			markets: [
				{ marketId: id(13), eventId: id(3), symbol: "META" },
				{ marketId: id(11), eventId: id(1), symbol: "TSLA" },
				{ marketId: id(12), eventId: id(2), symbol: "TSLA" },
			],
		});
	});
});

describe("the workflow's configuration for a network", () => {
	const sealed = {
		[id(1)]: { terms: stringToHex("terms one"), announcesAt: 1_792_000_000n },
		[id(2)]: { terms: stringToHex("terms one"), announcesAt: 1_792_000_000n },
		[id(3)]: { terms: stringToHex("terms three"), announcesAt: 1_792_000_000n },
	};
	const receiver = "0x00000000000000000000000000000000000c0de0";

	test("lists every event by issuer, its terms and announcement read from the chain", () => {
		const config = creConfig(
			{ ...withMarkets, TestnetReportProbe: { address: receiver } },
			manifest,
			10143,
			sealed,
		);
		expect(config.chainSelectorName).toBe("monad-testnet");
		expect(config.isTestnet).toBe(true);
		expect(config.resolver).toBe(
			(book.OptimisticResolver as { address: string }).address,
		);
		expect(config.receiver).toBe(receiver);
		expect(config.userAgent).toBe("Cuspate ops@cuspate.xyz");
		expect(config.issuers).toEqual([
			{
				issuer: "META",
				period: { quarter: 3, fiscalYear: 2026 },
				events: [
					{ eventId: id(3), terms: "terms three", announcesAt: 1_792_000_000 },
				],
			},
			{
				issuer: "TSLA",
				period: { quarter: 3, fiscalYear: 2026 },
				events: [
					{ eventId: id(1), terms: "terms one", announcesAt: 1_792_000_000 },
					{ eventId: id(2), terms: "terms one", announcesAt: 1_792_000_000 },
				],
			},
		]);
	});

	test("delivers to the receiver once it exists, and to the probe until then; never to nobody", () => {
		const both = {
			...withMarkets,
			TestnetReportProbe: { address: receiver },
			CreProposer: { address: "0x00000000000000000000000000000000000000aa" },
		};
		expect(creConfig(both, manifest, 10143, sealed).receiver).toBe(
			"0x00000000000000000000000000000000000000aa",
		);
		expect(() => creConfig(withMarkets, manifest, 10143, sealed)).toThrow(
			/receiver/,
		);
	});
});

describe("writing what was generated", () => {
	test("never overwrites a different file without being told to", () => {
		const file = path.join(
			mkdtempSync(path.join(tmpdir(), "gen-")),
			"out.json",
		);
		expect(writeGenerated(file, "one\n", false)).toBe("written");
		expect(writeGenerated(file, "one\n", false)).toBe("unchanged");
		expect(() => writeGenerated(file, "two\n", false)).toThrow(/differs/);
		expect(readFileSync(file, "utf8")).toBe("one\n");
		expect(writeGenerated(file, "two\n", true)).toBe("written");
		writeFileSync(file, "x");
	});
});
