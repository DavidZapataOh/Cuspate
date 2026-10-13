import { describe, expect, test } from "bun:test";
import { extractFigure, type Period } from "./source";

// Bun's own file and hashing APIs: the SDK types Node's modules as unusable, since a workflow compiled
// to WebAssembly has none of them, and these tests run on Bun.
const fixture = (file: string) =>
	Bun.file(`${import.meta.dir}/fixtures/${file}`);
const provenance: { documents: { file: string; sha256: string }[] } =
	await fixture("provenance.json").json();
const read = (file: string) => fixture(file).text();

/** Rewrites a recorded document, and fails the test if the rewrite matched nothing. */
function rewrite(
	document: string,
	pattern: RegExp,
	replacement: string,
): string {
	const rewritten = document.replace(pattern, replacement);
	expect(rewritten).not.toBe(document);
	return rewritten;
}
// The space the releases print between an amount and its unit is a non-breaking one.
const gap = "(?:&#160;|\\s)";
const highlight = (net: string, eps: string) =>
	new RegExp(
		`Non-GAAP net income of \\$${net}${gap}billion, or \\$${eps} per diluted share`,
	);
const reconciled = (eps: string) =>
	new RegExp(
		`(Non-GAAP diluted earnings per share[^$]*\\$\\s*(?:<[^>]*>\\s*)*)${eps}`,
	);

// The figures below were read by hand from each document's highlights, not produced by the parser.
const q4: Period = { quarter: 4, fiscalYear: 2026 };
const q3: Period = { quarter: 3, fiscalYear: 2026 };
const q4Release = await read("0000723125-26-000018-ex991.htm");
const q3Release = await read("0000723125-26-000013-ex991.htm");

describe("the recorded documents", () => {
	test("each is byte for byte the document that was fetched", async () => {
		expect(provenance.documents.length).toBe(5);
		for (const document of provenance.documents) {
			const bytes = await fixture(document.file).bytes();
			expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
				document.sha256,
			);
		}
	});
});

describe("extractFigure", () => {
	test("reads the non-GAAP diluted earnings per share the fourth-quarter release reports", () => {
		expect(extractFigure(q4Release, q4, 2)).toEqual({
			text: "33.42",
			value: 3342n,
			decimals: 2,
		});
	});

	test("reads the non-GAAP diluted earnings per share the third-quarter release reports", () => {
		expect(extractFigure(q3Release, q3, 2)).toEqual({
			text: "25.11",
			value: 2511n,
			decimals: 2,
		});
	});

	test("reads the quarter's figure, never the fiscal year's that follows it", () => {
		// The fourth-quarter release also reports the whole year's figure, 75.52, in the same form.
		const figure = extractFigure(q4Release, q4, 2);
		expect("value" in figure && figure.value).toBe(3342n);
	});

	test("scales the figure to the threshold's decimals without rounding", () => {
		expect(extractFigure(q4Release, q4, 4)).toEqual({
			text: "33.42",
			value: 334200n,
			decimals: 4,
		});
		expect(extractFigure(q4Release, q4, 0)).toEqual({ abstain: "precision" });
		expect(extractFigure(q4Release, q4, 1)).toEqual({ abstain: "precision" });
	});

	test("refuses decimals the registry would refuse to seal", () => {
		expect(() => extractFigure(q4Release, q4, 19)).toThrow(RangeError);
		expect(() => extractFigure(q4Release, q4, -1)).toThrow(RangeError);
		expect(() => extractFigure(q4Release, q4, 1.5)).toThrow(RangeError);
	});

	test("abstains for a period the document does not report", () => {
		expect(extractFigure(q4Release, q3, 2)).toEqual({
			abstain: "period-not-found",
		});
		expect(
			extractFigure(q3Release, { quarter: 3, fiscalYear: 2025 }, 2),
		).toEqual({ abstain: "period-not-found" });
	});

	test("abstains when the period's highlights carry no non-GAAP figure", () => {
		const without = rewrite(
			q4Release,
			highlight("38\\.40", "33\\.42"),
			"Adjusted income of $38.40 billion",
		);
		expect(extractFigure(without, q4, 2)).toEqual({
			abstain: "figure-not-found",
		});
	});

	test("abstains when the reconciliation disagrees with the highlights", () => {
		const disagreeing = rewrite(q4Release, reconciled("33\\.42"), "$133.41");
		expect(extractFigure(disagreeing, q4, 2)).toEqual({ abstain: "ambiguous" });
	});

	test("abstains when the reconciliation is missing, so nothing confirms the figure", () => {
		const unconfirmed = rewrite(
			q4Release,
			/Non-GAAP diluted earnings per share/g,
			"Adjusted per-share measure",
		);
		expect(extractFigure(unconfirmed, q4, 2)).toEqual({ abstain: "ambiguous" });
	});

	test("abstains when the outlook is the only per-share row", () => {
		// The outlook row ("Diluted earnings per share $38.15 +/- $1.00") is a forecast, never the result.
		const outlookOnly = rewrite(
			rewrite(q4Release, highlight("38\\.40", "33\\.42"), ""),
			/Non-GAAP diluted earnings per share/g,
			"Adjusted per-share measure",
		);
		expect(extractFigure(outlookOnly, q4, 2)).toEqual({
			abstain: "figure-not-found",
		});
	});

	test("reads a loss, whether the release prints it as a loss or in parentheses", () => {
		const loss = rewrite(
			rewrite(
				q3Release,
				highlight("28\\.86", "25\\.11"),
				"Non-GAAP net loss of $1.20 billion, or $1.31 per diluted share",
			),
			reconciled("25\\.11"),
			"$1(1.31)",
		);
		expect(extractFigure(loss, q3, 2)).toEqual({
			text: "-1.31",
			value: -131n,
			decimals: 2,
		});
	});

	test("does not depend on how the document is laid out", () => {
		const rewrapped = rewrite(q4Release, / /g, "  ").replace(/></g, ">\n\t\t<");
		expect(extractFigure(rewrapped, q4, 2)).toEqual(
			extractFigure(q4Release, q4, 2),
		);
		const entities = rewrite(
			rewrite(q4Release, /&#160;/g, "&nbsp;"),
			/ /g,
			"&#32;",
		);
		expect(extractFigure(entities, q4, 2)).toEqual(
			extractFigure(q4Release, q4, 2),
		);
	});

	test("does not depend on where in the document the reconciliation appears", () => {
		const at = q4Release.indexOf("RECONCILIATION OF GAAP TO NON-GAAP");
		expect(at).toBeGreaterThan(0);
		const reordered = `<body>${q4Release.slice(at)}</body>${q4Release.slice(0, at)}`;
		expect(extractFigure(reordered, q4, 2)).toEqual({
			text: "33.42",
			value: 3342n,
			decimals: 2,
		});
	});

	test("returns the identical result on every run", () => {
		const first = extractFigure(q4Release, q4, 2);
		for (let run = 0; run < 5; run++)
			expect(extractFigure(q4Release, q4, 2)).toEqual(first);
	});
});
