import { describe, expect, test } from "bun:test";
import { exhibitName, indexUrl, releaseFilings } from "./edgar";

const fixture = (file: string) =>
	Bun.file(`${import.meta.dir}/fixtures/${file}`).text();
// The issuer's ten most recent 8-K filings as the feed listed them on the fetch date: two earnings
// releases (item 2.02), filed 2026-06-24 and 2026-09-30, among filings about other matters.
const feed = await fixture("edgar-8k-feed-0000723125.xml");
const q4Index = await fixture("0000723125-26-000018-index.html");

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
			"https://www.sec.gov/Archives/edgar/data/723125/000072312526000018/0000723125-26-000018-index.html",
		);
	});
});

/** An index page with one table row per document, as EDGAR lays its index out. */
function indexPage(rows: [description: string, name: string, type: string][]) {
	const cells = rows
		.map(
			([description, name, type], seq) =>
				`<tr><td scope="row">${seq + 1}</td><td scope="row">${description}</td><td scope="row"><a href="/Archives/edgar/data/1/000000000026000001/${name}">${name}</a></td><td scope="row">${type}</td><td scope="row">1000</td></tr>`,
		)
		.join("\n");
	return `<table class="tableFile" summary="Document Format Files"><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>${cells}</table>`;
}

describe("exhibitName", () => {
	test("names the press release exhibit in a filing's index", () => {
		expect(exhibitName(q4Index)).toBe("a2026q4ex991-pressrelease.htm");
	});

	test("finds the press release by its type, whatever the filer named the file", async () => {
		const expected: [string, string][] = [
			["AMD/0000002488-26-000121-index.html", "q22026991.htm"],
			["NVDA/0001045810-26-000073-index.html", "q2fy27pr.htm"],
			["WMT/0000104169-26-000145-index.html", "earningsreleasefy27q2.htm"],
			["TSLA/0001628280-26-049213-index.html", "exhibit991.htm"],
			["TSLA/0001628280-26-064366-index.html", "exhibit991111111.htm"],
			["MSFT/0001193125-26-323632-index.html", "msft-ex99_1.htm"],
		];
		for (const [file, name] of expected) {
			expect(exhibitName(await fixture(file))).toBe(name);
		}
	});

	test("reads the type column, never the description", () => {
		expect(
			exhibitName(
				indexPage([
					["EX-99.1 slides", "slides.htm", "EX-99.2"],
					["Release", "release.htm", "EX-99.1"],
				]),
			),
		).toBe("release.htm");
		expect(
			exhibitName(indexPage([["EX-99.1 slides", "slides.htm", "EX-99.2"]])),
		).toBeNull();
	});

	test("names nothing when no exhibit 99.1 is listed, or when several are", () => {
		expect(exhibitName(indexPage([["Report", "d8k.htm", "8-K"]]))).toBeNull();
		expect(
			exhibitName(
				indexPage([
					["Release", "a.htm", "EX-99.1"],
					["Release", "b.htm", "EX-99.1"],
				]),
			),
		).toBeNull();
	});

	test("names nothing in a document that is not an index", () => {
		expect(exhibitName("not an index")).toBeNull();
		expect(
			exhibitName("<html>Request rate threshold exceeded</html>"),
		).toBeNull();
	});
});
