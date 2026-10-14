import assert from "node:assert/strict";
import { test } from "node:test";
import { ISSUERS } from "cuspate-shared";
import {
	buttonWords,
	conditionTitle,
	headline,
	panLabels,
} from "../../src/lib/naming.ts";

const tesla = { issuer: "TSLA" };
const meta = { issuer: "META" };
const primary = { threshold: 43n, decimals: 2, primary: true };
const fixed = { threshold: 48n, decimals: 2, primary: false };

test("the primary condition of an issuer that publishes the consensus figure says it beats expectations, naming the figure", () => {
	assert.equal(
		conditionTitle(tesla, primary),
		"Beats expectations ($0.43 adjusted EPS)",
	);
	assert.equal(
		headline(tesla, primary),
		"Buy Tesla only if they beat expectations.",
	);
	assert.deepEqual(panLabels(tesla, primary), [
		"If they beat",
		"If they don't",
	]);
	assert.deepEqual(buttonWords(tesla, primary), {
		buy: "Buy if they beat",
		other: "or if they don't",
		yesShort: "If they beat",
		noShort: "If they don't",
	});
});

test("a fixed threshold names the figure and the strict bound", () => {
	assert.equal(conditionTitle(tesla, fixed), "Adjusted EPS above $0.48");
	assert.equal(
		headline(tesla, fixed),
		"Buy Tesla only if adjusted EPS is above $0.48.",
	);
	assert.deepEqual(panLabels(tesla, fixed), ["If it's above $0.48", "If not"]);
	assert.deepEqual(buttonWords(tesla, fixed), {
		buy: "Buy if above $0.48",
		other: "or if not",
		yesShort: "If above",
		noShort: "If not",
	});
});

test("an issuer that publishes only GAAP EPS never reads as beating expectations, in any word the screens use", () => {
	for (const condition of [{ ...primary, threshold: 639n }, fixed]) {
		const words = [
			conditionTitle(meta, condition),
			headline(meta, condition),
			...panLabels(meta, condition),
			...Object.values(buttonWords(meta, condition)),
		].join(" ");
		assert.doesNotMatch(words, /expectation|beat/i);
	}
	assert.equal(
		conditionTitle(meta, { ...primary, threshold: 639n }),
		"EPS above $6.39",
	);
	assert.equal(
		headline(meta, { ...primary, threshold: 639n }),
		"Buy Meta only if EPS is above $6.39.",
	);
});

test("thresholds keep their decimals exactly, including large figures", () => {
	assert.equal(
		conditionTitle(
			{ issuer: "MU" },
			{ threshold: 3940n, decimals: 2, primary: false },
		),
		"Adjusted EPS above $39.40",
	);
	assert.equal(
		conditionTitle(meta, { threshold: 5n, decimals: 2, primary: false }),
		"EPS above $0.05",
	);
});

test("no issuer the shared profiles settle on GAAP EPS is ever said to beat expectations", () => {
	const gaap = ISSUERS.filter((p) => p.figureKind === "gaap-diluted-eps");
	assert.deepEqual(gaap.map((p) => p.ticker).sort(), [
		"AAPL",
		"GOOGL",
		"HOOD",
		"META",
	]);
	for (const profile of gaap) {
		const event = { issuer: profile.ticker };
		const words = [
			conditionTitle(event, primary),
			headline(event, primary),
			...panLabels(event, primary),
			...Object.values(buttonWords(event, primary)),
		].join(" ");
		assert.doesNotMatch(words, /expectation|beat/i, profile.ticker);
		assert.match(
			headline(event, primary),
			new RegExp(`^Buy ${profile.shortName} only if EPS`),
		);
	}
});

test("the other world's words: the button buys it and the link offers the first back", () => {
	assert.deepEqual(buttonWords(tesla, primary, false), {
		buy: "Buy if they don't",
		other: "or if they beat",
		yesShort: "If they beat",
		noShort: "If they don't",
	});
	assert.deepEqual(buttonWords(tesla, fixed, false), {
		buy: "Buy if not",
		other: "or if above $0.48",
		yesShort: "If above",
		noShort: "If not",
	});
});
