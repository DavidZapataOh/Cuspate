/**
 * What every issuer's reader shares: a release's text, the figures printed in it, and the two
 * independent signals that the release reports the period an event names.
 */
import type { AbstainReason, Period } from "../source";
import { toText } from "../source";

/** A figure as printed: signed, with exactly two decimals. */
export type Printed = { text: string; cents: bigint };

/** What a reader found: the figure, or why there is none. */
export type Reading = { text: string } | { abstain: AbstainReason };

/** A release's visible text, with typographic quotes and dashes made plain so labels match. */
export function plainText(document: string): string {
	return toText(document)
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/[–—―]/g, "-");
}

// A figure token: an optional dollar sign, optional parentheses for a negative, and exactly two
// decimals. An integer ("1", "(1)", "2,760") is a footnote marker or an amount in millions, and a
// percentage is a change; neither is ever a figure.
const FIGURE = /^\$?\(?\$?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\)?$/;
// Tokens a row may carry between its figures without ending: a lone dollar sign, a footnote marker,
// an amount without decimals.
const SKIPPED = /^(?:\$|\*|\(?\d{1,3}\)?|\$?\d{1,3}(?:,\d{3})+|\$?\d+)$/;

/** A printed figure, or null when the token is not one. */
export function figureOf(token: string): Printed | null {
	const match = FIGURE.exec(token);
	if (!match) return null;
	const negative = token.includes("(");
	const cents = BigInt(match[1].replaceAll(",", "") + match[2]);
	const whole = match[1].replaceAll(",", "");
	return {
		text: `${negative ? "-" : ""}${whole}.${match[2]}`,
		cents: negative ? -cents : cents,
	};
}

/**
 * The figures of a table row or a sentence, in order, starting right after `at`: tokens are read
 * while they are figures or tokens a row carries between figures, and the first other token ends
 * the row.
 */
export function figuresFrom(text: string, at: number): Printed[] {
	const figures: Printed[] = [];
	for (const raw of text.slice(at).trim().split(" ")) {
		// A figure that ends a sentence or a clause carries its punctuation.
		const token = raw.replace(/[.,;:]+$/, "");
		const figure = figureOf(token);
		if (figure) {
			figures.push(figure);
			continue;
		}
		if (SKIPPED.test(token) && token === raw) continue;
		break;
	}
	return figures;
}

/** Where each match of `pattern` ends in `text`. */
export function endsOf(text: string, pattern: RegExp): number[] {
	const global = new RegExp(
		pattern.source,
		pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
	);
	return [...text.matchAll(global)].map(
		(match) => match.index + match[0].length,
	);
}

/** Escapes a literal for use inside a regular expression. */
export function literal(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** "June 30, 2026" for `2026-06-30`. */
export function longDate(isoDate: string): string {
	const [year, month, day] = isoDate.split("-").map(Number);
	return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/**
 * Every date, written as releases write them, within `toleranceDays` of `isoDate`: the period end a
 * week-based calendar computes can sit a few days from the one the issuer prints.
 */
export function datesAround(isoDate: string, toleranceDays: number): string[] {
	const center = Date.parse(`${isoDate}T00:00:00Z`);
	const dates: string[] = [];
	for (let offset = -toleranceDays; offset <= toleranceDays; offset++) {
		dates.push(
			longDate(
				new Date(center + offset * 86_400_000).toISOString().slice(0, 10),
			),
		);
	}
	return dates;
}

const ORDINALS = ["First", "Second", "Third", "Fourth"];

/** "Third" for quarter 3. */
export function ordinal(period: Period): string {
	return ORDINALS[period.quarter - 1];
}

/**
 * The reading the agreement rule gives: one figure stated where the reader anchors, at least one
 * confirmation, and every confirmation equal to it. Anything else abstains.
 */
export function agree(anchors: Printed[], confirmations: Printed[]): Reading {
	const distinct = anchors.filter(
		(figure, index) =>
			anchors.findIndex((other) => other.cents === figure.cents) === index,
	);
	if (distinct.length === 0) return { abstain: "figure-not-found" };
	if (distinct.length > 1) return { abstain: "ambiguous" };
	const [figure] = distinct;
	if (
		confirmations.length === 0 ||
		!confirmations.every((other) => other.cents === figure.cents)
	) {
		return { abstain: "ambiguous" };
	}
	return { text: figure.text };
}
