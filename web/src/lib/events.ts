import { issuer, periodLabel } from "cuspate-shared";
import type { MarketEvent } from "../data/model.ts";

type Listed = Pick<
	MarketEvent,
	"eventKey" | "issuer" | "announcesAt" | "moneyIn" | "sector" | "period"
>;

/** What a search reads of an event: its company, ticker and quarter, and the figure it settles on. */
function searchable(event: Listed): string {
	const profile = issuer(event.issuer);
	return [
		profile.shortName,
		profile.name,
		event.issuer,
		periodLabel(profile, event.period),
		"earnings eps",
		profile.figureKind === "non-gaap-diluted-eps" ? "adjusted" : "gaap",
	]
		.join(" ")
		.toLowerCase();
}

const DAY = 86_400_000;

/** The filter chips over the open markets, in their order on screen. */
export const FILTERS = ["All", "This week", "Tech", "Ending soon"] as const;
/** One of `FILTERS`. */
export type Filter = (typeof FILTERS)[number];

/** Open events in the order they freeze; a tie goes to more money in, then to the ticker. */
function open<T extends Listed>(events: T[], now: number): T[] {
	return events
		.filter((event) => Date.parse(event.announcesAt) > now)
		.sort(
			(a, b) =>
				Date.parse(a.announcesAt) - Date.parse(b.announcesAt) ||
				(a.moneyIn === b.moneyIn ? 0 : a.moneyIn > b.moneyIn ? -1 : 1) ||
				a.issuer.localeCompare(b.issuer),
		);
}

/** The featured event: the next one to freeze. */
export function pickFeatured<T extends Listed>(
	events: T[],
	now: number,
): T | undefined {
	return open(events, now)[0];
}

/** The open events a chip and a search leave on screen, in the order they freeze. */
export function filterEvents<T extends Listed>(
	events: T[],
	filter: Filter,
	query: string,
	now: number,
): T[] {
	const words = query.trim().toLowerCase();
	return open(events, now).filter((event) => {
		const until = Date.parse(event.announcesAt) - now;
		if (filter === "This week" && until > 7 * DAY) return false;
		if (filter === "Tech" && event.sector !== "tech") return false;
		if (filter === "Ending soon" && until > 21 * DAY) return false;
		const text = searchable(event);
		return words === "" || words.split(/\s+/).every((w) => text.includes(w));
	});
}
