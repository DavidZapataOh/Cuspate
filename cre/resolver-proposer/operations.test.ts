import { describe, expect, test } from "bun:test";
import { CHAIN_ABSTAIN_REASONS, REPORT_GAS_LIMIT } from "./chain";
import { FETCH_ABSTAIN_REASONS, MAX_FILINGS } from "./fetch";
import { ABSTAIN_REASONS } from "./source";

const runbook = await Bun.file(`${import.meta.dir}/../README.md`).text();

describe("the operations runbook", () => {
	test("explains every result a run can log", () => {
		const results = [
			"proposed:",
			"abstain:not-deployed",
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
	});
});
