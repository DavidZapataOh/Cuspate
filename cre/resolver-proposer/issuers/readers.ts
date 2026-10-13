/**
 * One reader per issuer: where its earnings release states the figure its markets settle on, and a
 * second, independent place in the same release that must agree. Every reader also requires two
 * independent signals that the release reports the period the event names. Anything short of that
 * abstains: proposing nothing leaves the event to another run or to a person, while a wrong figure
 * would have to be disputed.
 */
import { issuer, periodEnd } from "cuspate-shared";
import { extractFigure, MAX_DECIMALS, type Period } from "../source";
import {
	agree,
	datesAround,
	endsOf,
	figureOf,
	figuresFrom,
	literal,
	longDate,
	ordinal,
	type Printed,
	plainText,
	type Reading,
} from "./common";

type End = { date: string; toleranceDays: number };
type Reader = (text: string, period: Period, end: End) => Reading;

const notFound: Reading = { abstain: "period-not-found" };

/** A pattern matching any of the dates a period end may be printed as. */
function anyDate(end: End): string {
	return datesAround(end.date, end.toleranceDays).map(literal).join("|");
}

/** The first figure after each match of `pattern`, for matches followed by at least one figure. */
function firstAfter(text: string, pattern: RegExp, column = 0): Printed[] {
	return endsOf(text, pattern)
		.map((at) => figuresFrom(text, at)[column])
		.filter((figure): figure is Printed => figure !== undefined);
}

/** The figure in `column` of the "Diluted" row that follows each match of `pattern`. */
function dilutedRowAfter(
	text: string,
	pattern: RegExp,
	column: number,
	occurrences = Number.POSITIVE_INFINITY,
): Printed[] {
	return endsOf(text, pattern)
		.slice(0, occurrences)
		.map((at) => {
			const diluted = text.indexOf(" Diluted ", at);
			return diluted === -1
				? undefined
				: figuresFrom(text, diluted + " Diluted ".length)[column];
		})
		.filter((figure): figure is Printed => figure !== undefined);
}

// Tesla's update: a five-quarter financial summary, headed Q<n>-<yyyy>, whose non-GAAP diluted EPS
// row is repeated in the reconciliation; the current quarter is the column its header names.
const tesla: Reader = (text, period) => {
	const column = `Q${period.quarter}-${period.fiscalYear}`;
	if (!text.includes(`Q${period.quarter} ${period.fiscalYear} Update`))
		return notFound;
	const header = /(Q[1-4]-\d{4})(?: Q[1-4]-\d{4}){4}/.exec(text);
	const index = header ? header[0].split(" ").indexOf(column) : -1;
	if (index === -1) return notFound;
	const rows = endsOf(
		text,
		/EPS attributable to common stockholders, diluted \(non-GAAP\)/,
	)
		.map((at) => figuresFrom(text, at))
		.filter((row) => row.length >= 5)
		.map((row) => row[index]);
	return agree(rows.slice(0, 1), rows.slice(1));
};

// Meta: the quarter's financial highlights state diluted EPS with the current year first, and the
// income statement's diluted row confirms it.
const meta: Reader = (text, period, end) => {
	if (
		!text.includes(`${ordinal(period)} Quarter ${period.fiscalYear} Results`) ||
		!text.includes(`quarter ended ${longDate(end.date)}`)
	) {
		return notFound;
	}
	return agree(
		firstAfter(text, /Diluted earnings per share \(EPS\)/),
		dilutedRowAfter(text, /Earnings per share: Basic/, 0),
	);
};

// Robinhood: a highlights bullet states diluted EPS; the income statement's first diluted row, with
// the current quarter in its second column, confirms it.
const robinhood: Reader = (text, period, end) => {
	if (
		!text.includes(`${ordinal(period)} Quarter ${period.fiscalYear} Results`) ||
		!text.includes(`ended ${longDate(end.date)}`)
	) {
		return notFound;
	}
	return agree(
		firstAfter(
			text,
			/Diluted earnings per share \("EPS"\) (?:increased|decreased) \d+(?:\.\d+)?% to /,
		),
		dilutedRowAfter(
			text,
			/Net income per share attributable to Robinhood common stockholders: Basic/,
			1,
			1,
		),
	);
};

// Microsoft: in the quarter's three-month block, the GAAP to non-GAAP table prints GAAP, the
// adjustment and non-GAAP (GAAP plus the adjustment), and the constant-currency table prints GAAP
// then non-GAAP. The headline sentence omits the figure when GAAP equals non-GAAP, so it is not read.
const microsoft: Reader = (text, period, end) => {
	const date = longDate(end.date);
	if (
		!text.includes(`${ordinal(period)} Quarter Results`) ||
		!text.includes(`quarter ended ${date}`)
	) {
		return notFound;
	}
	const headers = [
		...text.matchAll(
			/(Three|Six|Nine|Twelve) Months Ended ([A-Z][a-z]+ \d{1,2}), (\d{4})/g,
		),
	];
	const anchors: Printed[] = [];
	const confirmations: Printed[] = [];
	for (const at of endsOf(text, /Diluted Earnings per Share/)) {
		const header = headers.filter((match) => match.index < at).at(-1);
		const quarterBlock =
			header?.[1] === "Three" && `${header[2]}, ${header[3]}` === date;
		if (!quarterBlock) continue;
		const row = figuresFrom(text, at);
		if (row.length >= 3 && row[0].cents + row[1].cents === row[2].cents) {
			anchors.push(row[2]);
		} else if (row.length >= 2) {
			confirmations.push(row[1]);
		}
	}
	return agree(anchors, confirmations);
};

// Alphabet: a highlights bullet states EPS; both diluted net income per share rows, with the current
// year in their second column, confirm it. One figure serves every class of its stock.
const alphabet: Reader = (text, period, end) => {
	if (
		!text.includes(`${ordinal(period)} Quarter ${period.fiscalYear} Results`) ||
		!text.includes(`quarter ended ${longDate(end.date)}`)
	) {
		return notFound;
	}
	return agree(
		firstAfter(text, /EPS (?:increased|decreased) \d+(?:\.\d+)?% to /),
		firstAfter(text, /Diluted net income per (?:common )?share/, 1),
	);
};

// Apple: the opening paragraph states diluted EPS; the income statement's diluted row, current
// quarter first, confirms it. A 52/53-week year: the period end is matched within a week.
const apple: Reader = (text, period, end) => {
	const named = new RegExp(
		`fiscal ${period.fiscalYear} ${ordinal(period).toLowerCase()} quarter ended (?:${anyDate(end)})`,
	);
	if (!named.test(text)) return notFound;
	return agree(
		firstAfter(text, /Diluted earnings per share was /),
		dilutedRowAfter(text, /Earnings per share: Basic/, 0),
	);
};

// AMD: the sentence that opens "On a non-GAAP(*) basis" states diluted EPS; the reconciliation's
// non-GAAP net income and EPS row, current quarter first, confirms it.
const amd: Reader = (text, period, end) => {
	if (
		!text.includes(
			`${ordinal(period)} Quarter ${period.fiscalYear} Financial Results`,
		) ||
		!new RegExp(`Three Months Ended (?:${anyDate(end)})`).test(text)
	) {
		return notFound;
	}
	return agree(
		firstAfter(
			text,
			/On a non-GAAP\(\*\) basis,.{0,300}?diluted earnings per share was /,
		),
		firstAfter(text, /Non-GAAP net income \/ earnings per share/),
	);
};

// NVIDIA: one sentence states GAAP and non-GAAP EPS, non-GAAP second (or one figure for both); the
// non-GAAP row of the diluted net income per share reconciliation, current quarter first, confirms it.
const nvidia: Reader = (text, period, end) => {
	if (
		!text.includes(`${ordinal(period)} Quarter Fiscal ${period.fiscalYear}`) ||
		!new RegExp(`quarter ended (?:${anyDate(end)})`).test(text)
	) {
		return notFound;
	}
	const anchors: Printed[] = [];
	for (const match of text.matchAll(
		/GAAP and non-GAAP earnings per diluted share were (?:both (\S+?)[,.]|(\S+) and (\S+?),)/g,
	)) {
		const figure = figureOf(match[1] ?? match[3]);
		if (figure) anchors.push(figure);
	}
	return agree(anchors, firstAfter(text, /Non-GAAP\* /));
};

// Walmart: the headline states adjusted EPS; the reconciliation's block for the three months ending
// on the period end confirms it. Releases also print guidance and six-month figures, so the
// confirmation is read only inside that block.
const walmart: Reader = (text, period, end) => {
	const block = `Three Months Ended ${longDate(end.date)}`;
	if (
		!text.includes(`${ordinal(period).toLowerCase()} quarter results`) ||
		!text.includes(block)
	) {
		return notFound;
	}
	const confirmations: Printed[] = [];
	for (const at of endsOf(text, new RegExp(literal(block)))) {
		const next = text
			.slice(at)
			.search(/(?:Three|Six|Nine|Twelve) Months Ended/);
		const inside = next === -1 ? text.slice(at) : text.slice(at, at + next);
		confirmations.push(...firstAfter(inside, /Adjusted EPS /));
	}
	return agree(firstAfter(text, /Adjusted EPS (?:\d )?of /), confirmations);
};

// Micron: the reader the workflow was built with, unchanged.
const micron: Reader = (text, period) => {
	const figure = extractFigure(text, period, MAX_DECIMALS);
	return "abstain" in figure ? figure : { text: figure.text };
};

const READERS: Record<string, Reader> = {
	TSLA: tesla,
	META: meta,
	HOOD: robinhood,
	MSFT: microsoft,
	GOOGL: alphabet,
	AAPL: apple,
	AMD: amd,
	NVDA: nvidia,
	WMT: walmart,
	MU: micron,
};

/**
 * The figure an issuer's release reports for `period`, as printed, or why it abstains.
 * @param ticker The issuer.
 * @param document The release, HTML or text.
 * @param period The fiscal quarter the event names.
 */
export function readRelease(
	ticker: string,
	document: string,
	period: Period,
): Reading {
	const reader = READERS[ticker];
	if (!reader) throw new Error(`no reader for issuer ${ticker}`);
	const end = periodEnd(issuer(ticker), period);
	return reader(plainText(document), period, end);
}
