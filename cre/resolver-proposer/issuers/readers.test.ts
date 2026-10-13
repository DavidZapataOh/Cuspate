import { describe, expect, test } from "bun:test";
import type { Period } from "../source";
import { plainText } from "./common";
import { readRelease } from "./readers";

const fixture = (file: string) =>
	Bun.file(`${import.meta.dir}/../fixtures/${file}`).text();

type Release = { file: string; period: Period; figure: string };

// Each issuer's two most recent earnings releases, as recorded, and the figure its market settles on.
const RELEASES: Record<string, [Release, Release]> = {
	TSLA: [
		{
			file: "TSLA/0001628280-26-026551-exhibit991.htm",
			period: { quarter: 1, fiscalYear: 2026 },
			figure: "0.41",
		},
		{
			file: "TSLA/0001628280-26-049213-exhibit991.htm",
			period: { quarter: 2, fiscalYear: 2026 },
			figure: "0.33",
		},
	],
	META: [
		{
			file: "META/0001628280-26-028364-meta-03312026xexhibit991.htm",
			period: { quarter: 1, fiscalYear: 2026 },
			figure: "10.44",
		},
		{
			file: "META/0001628280-26-050596-meta-06302026xexhibit991.htm",
			period: { quarter: 2, fiscalYear: 2026 },
			figure: "6.18",
		},
	],
	HOOD: [
		{
			file: "HOOD/0001783879-26-000061-q12026robinhoodexhibit991.htm",
			period: { quarter: 1, fiscalYear: 2026 },
			figure: "0.38",
		},
		{
			file: "HOOD/0001783879-26-000113-q22026robinhoodexhibit991.htm",
			period: { quarter: 2, fiscalYear: 2026 },
			figure: "0.62",
		},
	],
	MSFT: [
		{
			file: "MSFT/0001193125-26-191457-msft-ex99_1.htm",
			period: { quarter: 3, fiscalYear: 2026 },
			figure: "4.27",
		},
		{
			file: "MSFT/0001193125-26-323632-msft-ex99_1.htm",
			period: { quarter: 4, fiscalYear: 2026 },
			figure: "4.74",
		},
	],
	GOOGL: [
		{
			file: "GOOGL/0001652044-26-000043-googexhibit991q12026.htm",
			period: { quarter: 1, fiscalYear: 2026 },
			figure: "5.11",
		},
		{
			file: "GOOGL/0001652044-26-000066-googexhibit991q22026.htm",
			period: { quarter: 2, fiscalYear: 2026 },
			figure: "9.11",
		},
	],
	AAPL: [
		{
			file: "AAPL/0000320193-26-000011-a8-kex991q2202603282026.htm",
			period: { quarter: 2, fiscalYear: 2026 },
			figure: "2.01",
		},
		{
			file: "AAPL/0000320193-26-000018-a8-kex991q3202606272026.htm",
			period: { quarter: 3, fiscalYear: 2026 },
			figure: "2.02",
		},
	],
	AMD: [
		{
			file: "AMD/0000002488-26-000072-q12026991.htm",
			period: { quarter: 1, fiscalYear: 2026 },
			figure: "1.37",
		},
		{
			file: "AMD/0000002488-26-000121-q22026991.htm",
			period: { quarter: 2, fiscalYear: 2026 },
			figure: "1.66",
		},
	],
	NVDA: [
		{
			file: "NVDA/0001045810-26-000051-q1fy27pr.htm",
			period: { quarter: 1, fiscalYear: 2027 },
			figure: "1.87",
		},
		{
			file: "NVDA/0001045810-26-000073-q2fy27pr.htm",
			period: { quarter: 2, fiscalYear: 2027 },
			figure: "2.22",
		},
	],
	WMT: [
		{
			file: "WMT/0000104169-26-000095-earningsreleasefy27q1.htm",
			period: { quarter: 1, fiscalYear: 2027 },
			figure: "0.66",
		},
		{
			file: "WMT/0000104169-26-000145-earningsreleasefy27q2.htm",
			period: { quarter: 2, fiscalYear: 2027 },
			figure: "0.81",
		},
	],
	MU: [
		{
			file: "0000723125-26-000013-ex991.htm",
			period: { quarter: 3, fiscalYear: 2026 },
			figure: "25.11",
		},
		{
			file: "0000723125-26-000018-ex991.htm",
			period: { quarter: 4, fiscalYear: 2026 },
			figure: "33.42",
		},
	],
};

// For the most recent release: a label whose removal leaves no stated figure, and a confirmation
// whose change leaves the two statements of the figure disagreeing. Applied to the release's text.
const MUTATIONS: Record<
	string,
	{ anchor: [string, string]; confirm: [string, string] }
> = {
	TSLA: {
		anchor: [
			"EPS attributable to common stockholders, diluted (non-GAAP)",
			"EPS, adjusted",
		],
		confirm: [
			"(0.08) EPS attributable to common stockholders, diluted (non-GAAP) 0.40 0.50 0.50 0.41 0.33",
			"(0.08) EPS attributable to common stockholders, diluted (non-GAAP) 0.40 0.50 0.50 0.41 0.34",
		],
	},
	META: {
		anchor: ["Diluted earnings per share (EPS)", "Diluted figure"],
		confirm: ["Diluted $ 6.18 $ 7.14 $ 16.62", "Diluted $ 6.19 $ 7.14 $ 16.62"],
	},
	HOOD: {
		anchor: ['Diluted earnings per share ("EPS")', "Diluted figure"],
		confirm: ["Diluted $ 0.42 $ 0.62 $ 0.38", "Diluted $ 0.42 $ 0.63 $ 0.38"],
	},
	MSFT: {
		anchor: [
			"Diluted Earnings per Share $4.81 $(0.07) $4.74",
			"Diluted figure $4.81 $(0.07) $4.74",
		],
		confirm: [
			"Diluted Earnings per Share $4.81 $4.74 $3.65",
			"Diluted Earnings per Share $4.81 $4.75 $3.65",
		],
	},
	GOOGL: {
		anchor: ["EPS increased 294% to $9.11", "EPS rose to a record"],
		confirm: [
			"Diluted net income per common share $ 2.31 $ 9.11 $ 5.12",
			"Diluted net income per common share $ 2.31 $ 9.12 $ 5.12",
		],
	},
	AAPL: {
		anchor: ["Diluted earnings per share was $2.02", "Diluted figure"],
		confirm: ["Diluted $ 2.02 $ 1.57 $ 6.88", "Diluted $ 2.03 $ 1.57 $ 6.88"],
	},
	AMD: {
		anchor: ["On a non-GAAP(*) basis", "On another basis"],
		confirm: [
			"Non-GAAP net income / earnings per share $ 2,760 $ 1.66",
			"Non-GAAP net income / earnings per share $ 2,760 $ 1.67",
		],
	},
	NVDA: {
		anchor: [
			"GAAP and non-GAAP earnings per diluted share were",
			"Per-share results were",
		],
		confirm: ["Non-GAAP* $ 2.22 $ 1.87", "Non-GAAP* $ 2.23 $ 1.87"],
	},
	WMT: {
		anchor: ["Adjusted EPS 1 of $0.81", "Adjusted result"],
		confirm: [
			"Adjusted EPS $0.81 Six Months Ended",
			"Adjusted EPS $0.82 Six Months Ended",
		],
	},
};

describe("readRelease", () => {
	for (const [ticker, releases] of Object.entries(RELEASES)) {
		for (const release of releases) {
			test(`${ticker} reads ${release.figure} from its Q${release.period.quarter} ${release.period.fiscalYear} release`, async () => {
				expect(
					readRelease(ticker, await fixture(release.file), release.period),
				).toEqual({ text: release.figure });
			});
		}

		test(`${ticker} finds no other quarter in a release`, async () => {
			const [first, second] = releases;
			expect(
				readRelease(ticker, await fixture(first.file), second.period),
			).toEqual({ abstain: "period-not-found" });
		});
	}

	test("an issuer reads nothing from another issuer's release", async () => {
		const tickers = Object.keys(RELEASES);
		for (const [index, ticker] of tickers.entries()) {
			const other = tickers[(index + 1) % tickers.length];
			const release = RELEASES[other][1];
			const outcome = readRelease(
				ticker,
				await fixture(release.file),
				RELEASES[ticker][1].period,
			);
			expect("abstain" in outcome, `${ticker} on ${other}`).toBe(true);
		}
	});

	for (const [ticker, mutation] of Object.entries(MUTATIONS)) {
		const release = RELEASES[ticker][1];
		test(`${ticker} abstains when its figure is not stated where it reads it`, async () => {
			const text = plainText(await fixture(release.file));
			expect(text.includes(mutation.anchor[0])).toBe(true);
			const outcome = readRelease(
				ticker,
				text.replaceAll(mutation.anchor[0], mutation.anchor[1]),
				release.period,
			);
			expect(outcome).toEqual({ abstain: "figure-not-found" });
		});

		test(`${ticker} abstains when the release's two statements of its figure disagree`, async () => {
			const text = plainText(await fixture(release.file));
			expect(text.includes(mutation.confirm[0])).toBe(true);
			const outcome = readRelease(
				ticker,
				text.replace(mutation.confirm[0], mutation.confirm[1]),
				release.period,
			);
			expect(outcome).toEqual({ abstain: "ambiguous" });
		});
	}

	test("a ticker without a reader is refused rather than read with another's", () => {
		expect(() =>
			readRelease("XYZ", "", { quarter: 1, fiscalYear: 2026 }),
		).toThrow(/no reader/);
	});
});
