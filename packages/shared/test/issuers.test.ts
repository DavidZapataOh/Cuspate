import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FIGURE_KINDS,
	ISSUERS,
	issuer,
	periodEnd,
	periodLabel,
} from "../src/issuers.ts";

test("every issuer has a ticker, a CIK as EDGAR's archive paths write it, and a known figure kind", () => {
	assert.ok(ISSUERS.length > 0);
	for (const profile of ISSUERS) {
		assert.match(profile.ticker, /^[A-Z]{1,5}$/);
		assert.match(profile.cik, /^[1-9]\d*$/, profile.ticker);
		assert.ok(FIGURE_KINDS.includes(profile.figureKind), profile.ticker);
	}
	assert.equal(
		new Set(ISSUERS.map((profile) => profile.ticker)).size,
		ISSUERS.length,
		"a ticker names one issuer",
	);
});

test("the ten issuers the markets list, each with the figure its release publishes", () => {
	const kinds = Object.fromEntries(
		ISSUERS.map((profile) => [profile.ticker, profile.figureKind]),
	);
	assert.deepEqual(kinds, {
		TSLA: "non-gaap-diluted-eps",
		MSFT: "non-gaap-diluted-eps",
		AMD: "non-gaap-diluted-eps",
		NVDA: "non-gaap-diluted-eps",
		WMT: "non-gaap-diluted-eps",
		MU: "non-gaap-diluted-eps",
		META: "gaap-diluted-eps",
		HOOD: "gaap-diluted-eps",
		AAPL: "gaap-diluted-eps",
		GOOGL: "gaap-diluted-eps",
	});
});

test("an unknown ticker is refused rather than guessed", () => {
	assert.throws(() => issuer("XYZ"), /unknown issuer/);
	assert.equal(issuer("TSLA").cik, "1318605");
});

// Period ends as the issuers' own releases and filings state them.
const ENDS: [string, 1 | 2 | 3 | 4, number, string][] = [
	["TSLA", 3, 2026, "2026-09-30"],
	["META", 2, 2026, "2026-06-30"],
	["GOOGL", 4, 2026, "2026-12-31"],
	["MSFT", 4, 2026, "2026-06-30"],
	["MSFT", 1, 2027, "2026-09-30"],
	["MSFT", 3, 2027, "2027-03-31"],
	["AAPL", 3, 2026, "2026-06-27"],
	["AAPL", 4, 2026, "2026-09-26"],
	["AMD", 2, 2026, "2026-06-27"],
	["NVDA", 2, 2027, "2026-07-26"],
	["NVDA", 3, 2027, "2026-10-25"],
	["WMT", 2, 2027, "2026-07-31"],
	["WMT", 3, 2027, "2026-10-31"],
	["WMT", 4, 2027, "2027-01-31"],
	["MU", 3, 2026, "2026-05-28"],
	["MU", 4, 2026, "2026-09-03"],
	["MU", 1, 2027, "2026-12-03"],
];

for (const [ticker, quarter, fiscalYear, end] of ENDS) {
	test(`${ticker} Q${quarter} of fiscal ${fiscalYear} ends on ${end}`, () => {
		assert.equal(periodEnd(issuer(ticker), { quarter, fiscalYear }).date, end);
	});
}

test("a week-based fiscal calendar allows a week of slack around its period end, a month-based one none", () => {
	assert.equal(
		periodEnd(issuer("AAPL"), { quarter: 3, fiscalYear: 2026 }).toleranceDays,
		7,
	);
	assert.equal(
		periodEnd(issuer("TSLA"), { quarter: 3, fiscalYear: 2026 }).toleranceDays,
		0,
	);
});

test("a period is labelled the way its issuer names it", () => {
	assert.equal(
		periodLabel(issuer("TSLA"), { quarter: 3, fiscalYear: 2026 }),
		"Q3 2026",
	);
	assert.equal(
		periodLabel(issuer("MSFT"), { quarter: 1, fiscalYear: 2027 }),
		"fiscal Q1 2027",
	);
	assert.equal(
		periodLabel(issuer("NVDA"), { quarter: 3, fiscalYear: 2027 }),
		"fiscal Q3 2027",
	);
});
