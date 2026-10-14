import {
	type FigureKind,
	issuer,
	type Period,
	periodEnd,
	periodLabel,
} from "cuspate-shared";

/** What the screens say about an event's issuer and quarter. */
export type About = {
	/** The name people call the company by: "Meta". */
	company: string;
	/** The figure its markets settle on. */
	figureKind: FigureKind;
	/** The quarter as the company names it: "Q3 2026", "fiscal Q1 2027". */
	periodLabel: string;
	/** The day the quarter ends, YYYY-MM-DD. */
	periodEnd: string;
};

/**
 * The facts about an event that belong to its issuer, read from the profiles every part of the
 * system shares, so the interface names the same figure and quarter the terms and the resolution do.
 * @throws for an issuer the markets do not list.
 */
export function about(event: { issuer: string; period: Period }): About {
	const profile = issuer(event.issuer);
	return {
		company: profile.shortName,
		figureKind: profile.figureKind,
		periodLabel: periodLabel(profile, event.period),
		periodEnd: periodEnd(profile, event.period).date,
	};
}
