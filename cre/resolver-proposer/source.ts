/**
 * Reads the figure an event's terms name from the issuer's earnings release: the non-GAAP diluted
 * earnings per share of one fiscal quarter, as filed with the SEC (exhibit 99.1 to the Form 8-K).
 *
 * A pure function of the document, so every node of the network that fetched the same bytes extracts
 * the same figure. It reads the figure where the release states it, in the highlights of the quarter
 * the terms name, and confirms it against the reconciliation table's current-quarter column. Anything
 * short of that agreement is an abstention, never a guess: proposing nothing leaves the event to
 * another run or to a person, while a wrong figure would have to be disputed.
 */

/** The fiscal quarter an event's terms name. */
export type Period = { quarter: 1 | 2 | 3 | 4; fiscalYear: number };

/**
 * A figure read from a document. `text` is the figure as printed, signed; `value` is it scaled by
 * `10 ** decimals`, the threshold's own scale, so that the two compare exactly.
 */
export type Figure = { text: string; value: bigint; decimals: number };

/**
 * Why nothing was read: the document does not cover the period, the period's highlights state no
 * figure, the statements of it disagree or are unconfirmed, or the figure carries more decimals than
 * the threshold and could only be compared after rounding, which the terms do not allow.
 */
export const ABSTAIN_REASONS = [
	"period-not-found",
	"figure-not-found",
	"ambiguous",
	"precision",
] as const;

/** One of `ABSTAIN_REASONS`. */
export type AbstainReason = (typeof ABSTAIN_REASONS)[number];

/** No figure, and why. */
export type Abstain = { abstain: AbstainReason };

/** The most decimals a sealed threshold may carry. */
export const MAX_DECIMALS = 18;

const NAMED_ENTITIES: Record<string, string> = {
	nbsp: " ",
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

const AMOUNT = String.raw`\$\s?(\(?\d[\d,]*(?:\.\d+)?\)?)`;
const HIGHLIGHT = new RegExp(
	`Non-GAAP net (income|loss) of [^,]*, or ${AMOUNT} per diluted share`,
	"gi",
);
const RECONCILED = new RegExp(
	String.raw`Non-GAAP diluted (?:earnings|loss|earnings \(loss\)) per share ${AMOUNT}`,
	"gi",
);

/** A printed amount: its digits without the decimal point, and how many of them follow it. */
type Amount = { digits: bigint; scale: number };

/** The document's visible text: tags dropped, entities decoded, every run of whitespace one space. */
export function toText(document: string): string {
	return document
		.replace(/<[^>]*>/g, " ")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
			if (body[0] !== "#") return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
			const code =
				body[1] === "x" || body[1] === "X"
					? Number.parseInt(body.slice(2), 16)
					: Number(body.slice(1));
			return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
		})
		.replace(/\s+/g, " ");
}

function amount(printed: string, loss: boolean): Amount {
	const negative = loss || printed.startsWith("(");
	const unsigned = printed.replace(/[(),]/g, "");
	const point = unsigned.indexOf(".");
	const scale = point === -1 ? 0 : unsigned.length - point - 1;
	const digits = BigInt(unsigned.replace(".", ""));
	return { digits: negative ? -digits : digits, scale };
}

function same(a: Amount, b: Amount): boolean {
	return (
		a.digits * 10n ** BigInt(b.scale) === b.digits * 10n ** BigInt(a.scale)
	);
}

function distinct(amounts: Amount[]): Amount[] {
	return amounts.filter(
		(candidate, index) =>
			amounts.findIndex((other) => same(other, candidate)) === index,
	);
}

/** The stretches of text that are the named quarter's highlights, each up to the next highlights heading. */
function highlights(text: string, period: Period): string[] {
	const heading = new RegExp(
		`Fiscal Q${period.quarter} ${period.fiscalYear} highlights`,
		"gi",
	);
	return [...text.matchAll(heading)].map((match) => {
		const start = match.index + match[0].length;
		const next = text.slice(start).search(/highlights/i);
		return next === -1 ? text.slice(start) : text.slice(start, start + next);
	});
}

/**
 * The figure the release reports for `period`, scaled to `decimals`, or why it abstains.
 * @param document The release as fetched, HTML.
 * @param period The fiscal quarter the terms name.
 * @param decimals The decimals of the sealed threshold the figure is compared with.
 */
export function extractFigure(
	document: string,
	period: Period,
	decimals: number,
): Figure | Abstain {
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
		throw new RangeError(
			`decimals must be an integer from 0 to ${MAX_DECIMALS}, not ${decimals}`,
		);
	}
	const text = toText(document);

	const sections = highlights(text, period);
	if (sections.length === 0) return { abstain: "period-not-found" };

	const stated = distinct(
		sections.flatMap((section) =>
			[...section.matchAll(HIGHLIGHT)].map((match) =>
				amount(match[2], match[1].toLowerCase() === "loss"),
			),
		),
	);
	if (stated.length === 0) return { abstain: "figure-not-found" };
	if (stated.length > 1) return { abstain: "ambiguous" };
	const [figure] = stated;

	const reconciled = [...text.matchAll(RECONCILED)].map((match) =>
		amount(match[1], false),
	);
	if (reconciled.length === 0 || !reconciled.every((row) => same(row, figure)))
		return { abstain: "ambiguous" };

	if (figure.scale > decimals) return { abstain: "precision" };
	return scale(printed(figure), decimals);
}

/** An amount as the release prints it, signed, with exactly its own decimals. */
function printed(figure: Amount): string {
	const magnitude = (figure.digits < 0n ? -figure.digits : figure.digits)
		.toString()
		.padStart(figure.scale + 1, "0");
	const sign = figure.digits < 0n ? "-" : "";
	return figure.scale === 0
		? `${sign}${magnitude}`
		: `${sign}${magnitude.slice(0, -figure.scale)}.${magnitude.slice(-figure.scale)}`;
}

/**
 * A printed figure ("33.42", "-1.31") scaled by `10 ** decimals`, exactly.
 * @param text The figure, signed, with no more decimals than `decimals`.
 * @param decimals The scale to express it at.
 */
export function scale(text: string, decimals: number): Figure {
	const figure = amount(text.replace(/^-/, ""), text.startsWith("-"));
	if (figure.scale > decimals)
		throw new RangeError(`${text} carries more than ${decimals} decimals`);
	return {
		text,
		value: figure.digits * 10n ** BigInt(decimals - figure.scale),
		decimals,
	};
}
