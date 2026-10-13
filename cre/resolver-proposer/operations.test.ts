import { describe, expect, test } from "bun:test";
import { ISSUERS } from "cuspate-shared";
import { CHAIN_ABSTAIN_REASONS, REPORT_GAS_LIMIT } from "./chain";
import {
	FETCH_ABSTAIN_REASONS,
	MAX_DOCUMENT_BYTES,
	MAX_FILINGS,
} from "./fetch";
import { ABSTAIN_REASONS } from "./source";
import { MAX_EVENTS_PER_ISSUER, ROTATION_SECONDS } from "./workflow";

const runbook = await Bun.file(`${import.meta.dir}/../README.md`).text();

describe("the operations runbook", () => {
	test("explains every result a run can log", () => {
		const results = [
			"proposed:",
			"abstain:not-deployed",
			"idle:nothing-due",
			...[
				...CHAIN_ABSTAIN_REASONS,
				...FETCH_ABSTAIN_REASONS,
				...ABSTAIN_REASONS,
			].map((reason) => `abstain:${reason}`),
		];
		for (const result of results) expect(runbook).toContain(`\`${result}`);
	});

	test("states the limits the code applies", () => {
		expect(runbook).toContain(Number(REPORT_GAS_LIMIT).toLocaleString("en-US"));
		expect(runbook).toContain(`at most ${MAX_FILINGS} filings`);
		expect(runbook).toContain(`stops at ${MAX_DOCUMENT_BYTES / 1_000_000} MB`);
		expect(runbook).toContain(`at most ${MAX_EVENTS_PER_ISSUER} events`);
		expect(runbook).toContain(`every ${ROTATION_SECONDS / 60} minutes`);
	});

	test("names every issuer the workflow reads, with the figure its markets settle on", () => {
		for (const profile of ISSUERS) {
			const kind =
				profile.figureKind === "gaap-diluted-eps" ? "GAAP" : "non-GAAP";
			expect(runbook).toContain(
				`| ${profile.name} | ${profile.ticker} | ${kind} diluted EPS`,
			);
		}
	});
});
