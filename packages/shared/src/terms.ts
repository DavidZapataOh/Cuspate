/**
 * The terms an event is sealed with: the text that says what figure settles it. One renderer for every
 * part of the system, so the sealing tool, the resolution workflow and the interface cannot drift. The
 * workflow never re-renders sealed terms; it compares the bytes it is configured with against the
 * chain's, so a later version of this renderer cannot change an event already sealed.
 */
import {
	type FigureKind,
	type IssuerProfile,
	type Period,
	periodEnd,
	periodLabel,
} from "./issuers.ts";

/** The version of the text below; its first line names it. */
export const TERMS_VERSION = 1;

/**
 * The largest terms the renderer produces. Sealing costs about 20,000 gas per 32 bytes of terms, and
 * the registry keeps them forever.
 */
export const MAX_TERMS_BYTES = 600;

/** What an event's terms need beyond the issuer's own facts. */
export type TermsInput = {
	period: Period;
	/** Where the figure is read if the primary source has not published it. */
	fallback: string;
	/** The UTC instant the fallback applies from, ISO 8601 with a Z. */
	fallbackFrom: string;
	/** A market the event refers to, if any. */
	referenceMarket?: string;
};

const METRIC: Record<FigureKind, string> = {
	"non-gaap-diluted-eps": "non-GAAP diluted earnings per share",
	"gaap-diluted-eps": "GAAP diluted earnings per share",
};

const ASCII = /^[\x20-\x7e]*$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * The terms for one event on one issuer's figure, as bytes-to-be: ASCII text, one fact per line.
 * @throws when an input is not ASCII, the fallback instant is not UTC, or the text passes the bound.
 */
export function renderTerms(profile: IssuerProfile, input: TermsInput): string {
	for (const text of [input.fallback, input.referenceMarket ?? ""]) {
		if (!ASCII.test(text)) throw new Error("terms are ASCII text");
	}
	if (!UTC_INSTANT.test(input.fallbackFrom)) {
		throw new Error(
			"the fallback applies from a UTC instant, such as 2026-10-22T20:00:00Z",
		);
	}
	const end = periodEnd(profile, input.period);
	const ends = end.toleranceDays === 0 ? "ended" : "ending on or about";
	const lines = [
		`Cuspate terms v${TERMS_VERSION}`,
		`Issuer: ${profile.name} (${profile.ticker}), SEC CIK ${profile.cik}`,
		`Figure: ${METRIC[profile.figureKind]}, in US dollars, as printed`,
		`Period: ${periodLabel(profile, input.period)}, ${ends} ${end.date}`,
		"Primary source: the issuer's earnings release, exhibit 99.1 to its Form 8-K on SEC EDGAR",
		`Fallback source: ${input.fallback}, from ${input.fallbackFrom}`,
		"The figure counts as first published; restatements are ignored.",
	];
	if (input.referenceMarket) {
		lines.push(`Reference market: ${input.referenceMarket}`);
	}
	const terms = lines.join("\n");
	const bytes = new TextEncoder().encode(terms).length;
	if (bytes > MAX_TERMS_BYTES) {
		throw new Error(`terms are ${bytes} bytes, more than ${MAX_TERMS_BYTES}`);
	}
	return terms;
}
