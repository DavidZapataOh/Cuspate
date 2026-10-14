/**
 * The issuers markets are written on, as facts every part of the system shares: the figure each one's
 * earnings release publishes, how it names a fiscal quarter, and when that quarter ends. Pure data and
 * pure functions, so the resolution workflow, the sealing tool and the interface read the same thing.
 */

/** The fiscal quarter an event names, in the issuer's own fiscal year. */
export type Period = { quarter: 1 | 2 | 3 | 4; fiscalYear: number };

/**
 * The figure a market settles on. Issuers that publish an adjusted earnings per share are settled on
 * it, because it is the figure their results are compared with; issuers that publish none are settled
 * on the GAAP figure, and their markets never claim to measure an expectation.
 */
export const FIGURE_KINDS = [
	"non-gaap-diluted-eps",
	"gaap-diluted-eps",
] as const;

/** One of `FIGURE_KINDS`. */
export type FigureKind = (typeof FIGURE_KINDS)[number];

/**
 * How an issuer's fiscal quarters end. `month` quarters end on the last day of a calendar month;
 * week-based quarters end on a weekday near the end of a month, which can fall a few days either side
 * of it. `endMonths` lists, for quarters 1 to 4, the month a quarter ends in, and `yearOffsets` the
 * calendar year of that month relative to the fiscal year.
 */
type Calendar =
	| { kind: "month"; endMonths: Quad; yearOffsets: Quad }
	| {
			kind: "last-weekday";
			weekday: number;
			endMonths: Quad;
			yearOffsets: Quad;
	  }
	| {
			kind: "closest-weekday";
			weekday: number;
			endMonths: Quad;
			yearOffsets: Quad;
	  };

type Quad = readonly [number, number, number, number];

/** An issuer, as the system knows it. */
export type IssuerProfile = {
	/** Its ticker, upper case. */
	ticker: string;
	/** Its legal name, as its filings state it. */
	name: string;
	/** The name people call it by, which the interface writes: "Meta", not "Meta Platforms, Inc.". */
	shortName: string;
	/** Its SEC Central Index Key, as EDGAR's archive paths write it: no leading zeros. */
	cik: string;
	/** The figure its markets settle on. */
	figureKind: FigureKind;
	/** Whether it names quarters by its fiscal year ("fiscal Q1 2027") or by the calendar ("Q3 2026"). */
	fiscalNaming: boolean;
	calendar: Calendar;
};

const CALENDAR_YEAR: Calendar = {
	kind: "month",
	endMonths: [3, 6, 9, 12],
	yearOffsets: [0, 0, 0, 0],
};

const SATURDAY = 6;
const SUNDAY = 0;
const THURSDAY = 4;

/** The issuers the markets list. */
export const ISSUERS: readonly IssuerProfile[] = [
	{
		ticker: "TSLA",
		name: "Tesla, Inc.",
		shortName: "Tesla",
		cik: "1318605",
		figureKind: "non-gaap-diluted-eps",
		fiscalNaming: false,
		calendar: CALENDAR_YEAR,
	},
	{
		ticker: "META",
		name: "Meta Platforms, Inc.",
		shortName: "Meta",
		cik: "1326801",
		figureKind: "gaap-diluted-eps",
		fiscalNaming: false,
		calendar: CALENDAR_YEAR,
	},
	{
		ticker: "HOOD",
		name: "Robinhood Markets, Inc.",
		shortName: "Robinhood",
		cik: "1783879",
		figureKind: "gaap-diluted-eps",
		fiscalNaming: false,
		calendar: CALENDAR_YEAR,
	},
	{
		// The fiscal year ends on June 30.
		ticker: "MSFT",
		name: "Microsoft Corporation",
		shortName: "Microsoft",
		cik: "789019",
		figureKind: "non-gaap-diluted-eps",
		fiscalNaming: true,
		calendar: {
			kind: "month",
			endMonths: [9, 12, 3, 6],
			yearOffsets: [-1, -1, 0, 0],
		},
	},
	{
		// One diluted net income per share for every class of its stock.
		ticker: "GOOGL",
		name: "Alphabet Inc.",
		shortName: "Alphabet",
		cik: "1652044",
		figureKind: "gaap-diluted-eps",
		fiscalNaming: false,
		calendar: CALENDAR_YEAR,
	},
	{
		// A 52/53-week year ending on the last Saturday of September.
		ticker: "AAPL",
		name: "Apple Inc.",
		shortName: "Apple",
		cik: "320193",
		figureKind: "gaap-diluted-eps",
		fiscalNaming: true,
		calendar: {
			kind: "last-weekday",
			weekday: SATURDAY,
			endMonths: [12, 3, 6, 9],
			yearOffsets: [-1, 0, 0, 0],
		},
	},
	{
		// A 52/53-week year ending on the last Saturday of December.
		ticker: "AMD",
		name: "Advanced Micro Devices, Inc.",
		shortName: "AMD",
		cik: "2488",
		figureKind: "non-gaap-diluted-eps",
		fiscalNaming: false,
		calendar: {
			kind: "last-weekday",
			weekday: SATURDAY,
			endMonths: [3, 6, 9, 12],
			yearOffsets: [0, 0, 0, 0],
		},
	},
	{
		// A 52/53-week year ending on the last Sunday of January.
		ticker: "NVDA",
		name: "NVIDIA Corporation",
		shortName: "NVIDIA",
		cik: "1045810",
		figureKind: "non-gaap-diluted-eps",
		fiscalNaming: true,
		calendar: {
			kind: "last-weekday",
			weekday: SUNDAY,
			endMonths: [4, 7, 10, 1],
			yearOffsets: [-1, -1, -1, 0],
		},
	},
	{
		// The fiscal year ends on January 31; the release calls the figure adjusted EPS.
		ticker: "WMT",
		name: "Walmart Inc.",
		shortName: "Walmart",
		cik: "104169",
		figureKind: "non-gaap-diluted-eps",
		fiscalNaming: true,
		calendar: {
			kind: "month",
			endMonths: [4, 7, 10, 1],
			yearOffsets: [-1, -1, -1, 0],
		},
	},
	{
		// A 52/53-week year ending on the Thursday closest to August 31.
		ticker: "MU",
		name: "Micron Technology, Inc.",
		shortName: "Micron",
		cik: "723125",
		figureKind: "non-gaap-diluted-eps",
		fiscalNaming: true,
		calendar: {
			kind: "closest-weekday",
			weekday: THURSDAY,
			endMonths: [11, 2, 5, 8],
			yearOffsets: [-1, 0, 0, 0],
		},
	},
];

/**
 * The issuer a ticker names.
 * @param ticker Upper case.
 */
export function issuer(ticker: string): IssuerProfile {
	const found = ISSUERS.find((profile) => profile.ticker === ticker);
	if (!found) throw new Error(`unknown issuer: ${ticker}`);
	return found;
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/** The last day of a month, at midnight UTC. `month` is 1 to 12. */
function lastOfMonth(year: number, month: number): Date {
	return new Date(Date.UTC(year, month, 0));
}

/**
 * The day a period ends, and how many days either side of it a release may date it: none for a
 * quarter that ends with a calendar month, a week for a week-based calendar.
 */
export function periodEnd(
	profile: IssuerProfile,
	period: Period,
): { date: string; toleranceDays: number } {
	const { calendar } = profile;
	// A quarter is 1 to 4, so its index is a position the four-entry tuples have.
	const index = (period.quarter - 1) as 0 | 1 | 2 | 3;
	const month = calendar.endMonths[index];
	const year = period.fiscalYear + calendar.yearOffsets[index];
	const last = lastOfMonth(year, month);
	if (calendar.kind === "month") return { date: day(last), toleranceDays: 0 };
	const back = (last.getUTCDay() - calendar.weekday + 7) % 7;
	if (calendar.kind === "last-weekday") {
		return {
			date: day(new Date(last.getTime() - back * 86_400_000)),
			toleranceDays: 7,
		};
	}
	// The closest such weekday: back up to three days, or forward up to three.
	const shift = back <= 3 ? -back : 7 - back;
	return {
		date: day(new Date(last.getTime() + shift * 86_400_000)),
		toleranceDays: 7,
	};
}

/** The period as its issuer names it: "Q3 2026", or "fiscal Q1 2027" for an issuer counting fiscal years. */
export function periodLabel(profile: IssuerProfile, period: Period): string {
	const label = `Q${period.quarter} ${period.fiscalYear}`;
	return profile.fiscalNaming ? `fiscal ${label}` : label;
}
