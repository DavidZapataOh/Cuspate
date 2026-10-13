import assert from "node:assert/strict";
import { test } from "node:test";
import { ISSUERS, issuer } from "../src/issuers.ts";
import { MAX_TERMS_BYTES, renderTerms, TERMS_VERSION } from "../src/terms.ts";

const BASE = {
	fallback: "the issuer's investor relations website",
	fallbackFrom: "2026-10-22T20:00:00Z",
};

test("the terms open with their version and name the issuer, the exact figure, the period and its end", () => {
	const terms = renderTerms(issuer("TSLA"), {
		...BASE,
		period: { quarter: 3, fiscalYear: 2026 },
	});
	const lines = terms.split("\n");
	assert.equal(lines[0], `Cuspate terms v${TERMS_VERSION}`);
	assert.match(terms, /Tesla, Inc\. \(TSLA\), SEC CIK 1318605/);
	assert.match(terms, /non-GAAP diluted earnings per share, in US dollars/);
	assert.match(terms, /Q3 2026, ended 2026-09-30/);
	assert.match(terms, /exhibit 99\.1/);
	assert.match(terms, /2026-10-22T20:00:00Z/);
	assert.match(terms, /first published; restatements are ignored/);
});

test("a GAAP issuer's terms name the GAAP figure and never an expectation", () => {
	const terms = renderTerms(issuer("META"), {
		...BASE,
		period: { quarter: 3, fiscalYear: 2026 },
	});
	assert.match(terms, /GAAP diluted earnings per share/);
	assert.doesNotMatch(terms, /non-GAAP/);
	assert.doesNotMatch(terms, /expect|consensus/i);
});

test("a week-based period ends on or about its computed date", () => {
	const terms = renderTerms(issuer("AAPL"), {
		...BASE,
		period: { quarter: 4, fiscalYear: 2026 },
	});
	assert.match(terms, /fiscal Q4 2026, ending on or about 2026-09-26/);
});

test("every issuer's terms are ASCII and within the bound, with the longest reference market", () => {
	const referenceMarket = "x".repeat(80);
	for (const profile of ISSUERS) {
		const terms = renderTerms(profile, {
			...BASE,
			referenceMarket,
			period: { quarter: 4, fiscalYear: 2026 },
		});
		assert.ok(
			[...terms].every((char) => char === "\n" || (char >= " " && char <= "~")),
			`${profile.ticker} is ASCII text`,
		);
		assert.ok(
			Buffer.byteLength(terms) <= MAX_TERMS_BYTES,
			`${profile.ticker}: ${Buffer.byteLength(terms)} bytes`,
		);
	}
});

test("the same inputs render the same bytes", () => {
	const input = { ...BASE, period: { quarter: 2, fiscalYear: 2027 } as const };
	assert.equal(
		renderTerms(issuer("NVDA"), input),
		renderTerms(issuer("NVDA"), input),
	);
});

test("text that is not ASCII, a time that is not UTC, or terms past the bound are refused", () => {
	const period = { quarter: 3, fiscalYear: 2026 } as const;
	assert.throws(
		() =>
			renderTerms(issuer("TSLA"), {
				...BASE,
				period,
				fallback: `caf${String.fromCharCode(0xe9)}`,
			}),
		/ASCII/,
	);
	assert.throws(
		() =>
			renderTerms(issuer("TSLA"), {
				...BASE,
				period,
				fallbackFrom: "2026-10-22 20:00",
			}),
		/UTC instant/,
	);
	assert.throws(
		() =>
			renderTerms(issuer("TSLA"), {
				...BASE,
				period,
				referenceMarket: "y".repeat(500),
			}),
		/bytes/,
	);
});
