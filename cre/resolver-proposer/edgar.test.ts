import { describe, expect, test } from "bun:test";
import { exhibitName, indexUrl, releaseFilings } from "./edgar";

const fixture = (file: string) =>
	Bun.file(`${import.meta.dir}/fixtures/${file}`).text();
// The issuer's ten most recent 8-K filings as the feed listed them on the fetch date: two earnings
// releases (item 2.02), filed 2026-06-24 and 2026-09-30, among filings about other matters.
const feed = await fixture("edgar-8k-feed-0000723125.xml");
const q4Index = await fixture("0000723125-26-000018-index.json");

describe("releaseFilings", () => {
	test("lists the earnings releases filed on or after a date, earliest first", () => {
		expect(
			releaseFilings(feed, "2026-06-10").map((filing) => filing.accession),
		).toEqual(["0000723125-26-000013", "0000723125-26-000018"]);
		expect(releaseFilings(feed, "2026-09-30")).toEqual([
			{ accession: "0000723125-26-000018", filed: "2026-09-30", cik: "723125" },
		]);
	});

	test("lists nothing before the release is filed", () => {
		expect(releaseFilings(feed, "2026-10-01")).toEqual([]);
	});

	test("ignores 8-K filings about anything but results", () => {
		// The feed's 2026-08-26 filing is an 8-K under items 5.02 and 9.01.
		expect(
			releaseFilings(feed, "2026-07-01").map((filing) => filing.filed),
		).toEqual(["2026-09-30"]);
	});

	test("ignores an amendment, so the release first published is the one read", () => {
		const amended = feed.replace(
			/(<accession-number>0000723125-26-000013<\/accession-number>[\s\S]*?<filing-type>)8-K(<\/filing-type>)/,
			"$18-K/A$2",
		);
		expect(amended).not.toBe(feed);
		expect(
			releaseFilings(amended, "2026-06-10").map((filing) => filing.accession),
		).toEqual(["0000723125-26-000018"]);
	});

	test("reads nothing from a document that is not the feed", () => {
		expect(
			releaseFilings(
				"<html>Request rate threshold exceeded</html>",
				"2026-06-10",
			),
		).toEqual([]);
	});

	test("locates a filing's index under the issuer's archive", () => {
		expect(
			indexUrl({
				accession: "0000723125-26-000018",
				filed: "2026-09-30",
				cik: "723125",
			}),
		).toBe(
			"https://www.sec.gov/Archives/edgar/data/723125/000072312526000018/index.json",
		);
	});
});

describe("exhibitName", () => {
	test("names the press release exhibit in a filing's index", () => {
		expect(exhibitName(q4Index)).toBe("a2026q4ex991-pressrelease.htm");
	});

	test("accepts the naming conventions filers use for exhibit 99.1", () => {
		for (const name of [
			"ex99-1.htm",
			"ex991.htm",
			"d123dex991.htm",
			"exhibit99_1.htm",
			"ex-99.1.html",
		]) {
			expect(
				exhibitName(JSON.stringify({ directory: { item: [{ name }] } })),
			).toBe(name);
		}
	});

	test("names nothing when no exhibit 99.1 is listed, or when several are", () => {
		const none = q4Index.replace(
			"a2026q4ex991-pressrelease.htm",
			"a2026q4-pressrelease.htm",
		);
		expect(exhibitName(none)).toBeNull();
		for (const name of ["ex9910.htm", "ex99.htm", "ex991.xml"]) {
			expect(
				exhibitName(JSON.stringify({ directory: { item: [{ name }] } })),
			).toBeNull();
		}
		const two = JSON.stringify({
			directory: { item: [{ name: "ex991.htm" }, { name: "ex99-1a.htm" }] },
		});
		expect(exhibitName(two)).toBeNull();
	});

	test("names nothing in a document that is not an index", () => {
		expect(exhibitName("not json")).toBeNull();
		expect(exhibitName(JSON.stringify({ directory: {} }))).toBeNull();
	});
});
