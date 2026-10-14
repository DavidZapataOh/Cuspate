import assert from "node:assert/strict";
import { test } from "node:test";
import { about } from "../../src/lib/issuer.ts";

test("an event's company, figure and period come from the shared issuer profiles", () => {
	assert.deepEqual(
		about({ issuer: "MSFT", period: { quarter: 1, fiscalYear: 2027 } }),
		{
			company: "Microsoft",
			figureKind: "non-gaap-diluted-eps",
			periodLabel: "fiscal Q1 2027",
			periodEnd: "2026-09-30",
		},
	);
	assert.deepEqual(
		about({ issuer: "META", period: { quarter: 3, fiscalYear: 2026 } }),
		{
			company: "Meta",
			figureKind: "gaap-diluted-eps",
			periodLabel: "Q3 2026",
			periodEnd: "2026-09-30",
		},
	);
});

test("an issuer the markets do not list is refused rather than named", () => {
	assert.throws(() =>
		about({ issuer: "XYZ", period: { quarter: 1, fiscalYear: 2026 } }),
	);
});
