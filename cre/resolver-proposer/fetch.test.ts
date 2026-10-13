import { describe, expect } from "bun:test";
import { HttpActionsMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import {
	decodeOutcome,
	encodeOutcome,
	type FigureRequest,
	feedUrl,
	MAX_FILINGS,
	readFigure,
} from "./fetch";

const bytes = async (file: string) =>
	Buffer.from(await Bun.file(`${import.meta.dir}/fixtures/${file}`).bytes());
const archive = "https://www.sec.gov/Archives/edgar/data/723125";
// EDGAR as it answered on the fetch date, address by address.
const edgar: Record<string, Buffer> = {
	[feedUrl("723125")]: await bytes("edgar-8k-feed-0000723125.xml"),
	[`${archive}/000072312526000013/index.json`]: await bytes(
		"0000723125-26-000013-index.json",
	),
	[`${archive}/000072312526000018/index.json`]: await bytes(
		"0000723125-26-000018-index.json",
	),
	[`${archive}/000072312526000013/a2026q3ex991-pressrelease.htm`]: await bytes(
		"0000723125-26-000013-ex991.htm",
	),
	[`${archive}/000072312526000018/a2026q4ex991-pressrelease.htm`]: await bytes(
		"0000723125-26-000018-ex991.htm",
	),
};

const q4: FigureRequest = {
	cik: "723125",
	notBefore: "2026-09-01",
	userAgent: "Cuspate research@cuspate.invalid",
	period: { quarter: 4, fiscalYear: 2026 },
	decimals: 2,
};

/** Serves `site` to the workflow, and records what it asked for. */
function serve(site: Record<string, Buffer | number>) {
	const asked: {
		url: string;
		method: string;
		headers: Record<string, string>;
	}[] = [];
	HttpActionsMock.testInstance().sendRequest = (input) => {
		asked.push({
			url: input.url,
			method: input.method,
			headers: { ...input.headers },
		});
		const page = site[input.url] ?? 404;
		return typeof page === "number"
			? { statusCode: page, body: Buffer.from("Not found").toString("base64") }
			: { statusCode: 200, body: page.toString("base64") };
	};
	return asked;
}

describe("readFigure", () => {
	test("finds the release the issuer filed and reads its figure", () => {
		const asked = serve(edgar);
		expect(readFigure(newTestRuntime(), q4)).toEqual({
			text: "33.42",
			value: 3342n,
			decimals: 2,
		});
		expect(asked.map((request) => request.url)).toEqual([
			feedUrl("723125"),
			`${archive}/000072312526000018/index.json`,
			`${archive}/000072312526000018/a2026q4ex991-pressrelease.htm`,
		]);
	});

	test("reads the earliest release filed on or after the date the terms name", () => {
		serve(edgar);
		const q3 = {
			...q4,
			notBefore: "2026-06-10",
			period: { quarter: 3, fiscalYear: 2026 },
		} as const;
		expect(readFigure(newTestRuntime(), q3)).toEqual({
			text: "25.11",
			value: 2511n,
			decimals: 2,
		});
	});

	test("passes over an earlier results filing that reports another period", () => {
		// The date the workflow searches from is a lower bound, so an earlier results filing can be
		// listed first; the first release that reports the period is the one read.
		const asked = serve(edgar);
		expect(
			readFigure(newTestRuntime(), { ...q4, notBefore: "2026-06-10" }),
		).toEqual({
			text: "33.42",
			value: 3342n,
			decimals: 2,
		});
		expect(asked.length).toBe(5);
	});

	test("abstains when no listed release reports the period", () => {
		serve(edgar);
		const q2 = {
			...q4,
			notBefore: "2026-06-10",
			period: { quarter: 2, fiscalYear: 2026 },
		} as const;
		expect(readFigure(newTestRuntime(), q2)).toEqual({
			abstain: "period-not-found",
		});
	});

	test("reads at most three filings, so a run stays within the requests it may make", () => {
		const asked = serve(edgar);
		const q2 = {
			...q4,
			notBefore: "2026-01-01",
			period: { quarter: 2, fiscalYear: 2026 },
		} as const;
		readFigure(newTestRuntime(), q2);
		expect(asked.length).toBeLessThanOrEqual(1 + 2 * MAX_FILINGS);
	});

	test("asks by GET, declaring who is asking, every time", () => {
		// The SEC refuses requests that do not identify their sender.
		const asked = serve(edgar);
		readFigure(newTestRuntime(), q4);
		expect(asked.length).toBe(3);
		for (const request of asked) {
			expect(request.method).toBe("GET");
			expect(request.headers).toEqual({ "User-Agent": q4.userAgent });
		}
	});

	test("abstains, asking no further, before the release is filed", () => {
		const asked = serve(edgar);
		expect(
			readFigure(newTestRuntime(), { ...q4, notBefore: "2026-10-01" }),
		).toEqual({ abstain: "not-filed" });
		expect(asked.length).toBe(1);
	});

	test("abstains when the filing's index names no press release", () => {
		const index = `${archive}/000072312526000018/index.json`;
		serve({
			...edgar,
			[index]: Buffer.from(edgar[index].toString().replace("ex991", "ex99")),
		});
		expect(readFigure(newTestRuntime(), q4)).toEqual({
			abstain: "exhibit-not-found",
		});
	});

	test("abstains when the request itself fails: a response over the size limit, a timeout", () => {
		for (const url of Object.keys(edgar).filter(
			(url) => !url.includes("000013"),
		)) {
			HttpActionsMock.testInstance().sendRequest = (input) => {
				if (input.url === url)
					throw new Error("response exceeds the maximum size");
				return { statusCode: 200, body: edgar[input.url].toString("base64") };
			};
			expect(readFigure(newTestRuntime(), q4)).toEqual({
				abstain: "unavailable",
			});
		}
	});

	test("abstains, reading nothing, when any source answers with anything but the document", () => {
		for (const url of Object.keys(edgar).filter(
			(url) => !url.includes("000013"),
		)) {
			for (const status of [403, 404, 429, 500]) {
				serve({ ...edgar, [url]: status });
				expect(readFigure(newTestRuntime(), q4)).toEqual({
					abstain: "unavailable",
				});
			}
		}
	});
});

describe("the outcome the nodes agree on", () => {
	test("is a canonical string that round-trips every outcome", () => {
		const figure = { text: "33.42", value: 3342n, decimals: 2 };
		expect(decodeOutcome(encodeOutcome(figure), 2)).toEqual(figure);
		const loss = { text: "-1.31", value: -1310n, decimals: 3 };
		expect(decodeOutcome(encodeOutcome(loss), 3)).toEqual(loss);
		expect(decodeOutcome(encodeOutcome({ abstain: "ambiguous" }), 2)).toEqual({
			abstain: "ambiguous",
		});
	});

	test("does not carry the scaled value, which every node derives from the printed figure", () => {
		expect(encodeOutcome({ text: "33.42", value: 3342n, decimals: 2 })).toBe(
			"figure:33.42",
		);
		expect(encodeOutcome({ abstain: "precision" })).toBe("abstain:precision");
	});
});
