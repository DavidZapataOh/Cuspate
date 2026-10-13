import {
	consensusIdenticalAggregation,
	HTTPClient,
	type HTTPSendRequester,
	type Runtime,
} from "@chainlink/cre-sdk";
import { documentUrl, exhibitName, indexUrl, releaseFilings } from "./edgar";
import {
	type AbstainReason,
	extractFigure,
	type Figure,
	type Period,
	scale,
} from "./source";

/** Which release the workflow reads, and how it reads it. */
export type FigureRequest = {
	/** The issuer's SEC Central Index Key, without leading zeros. */
	cik: string;
	/** The first date the release can carry, `YYYY-MM-DD`: the announcement the terms name. */
	notBefore: string;
	/** Who is asking, a project contact; the SEC refuses requests that do not say. */
	userAgent: string;
	/** The fiscal quarter the terms name. */
	period: Period;
	/** The decimals of the sealed threshold. */
	decimals: number;
};

/**
 * Why fetching read nothing: `not-filed` before the release is filed, `exhibit-not-found` when its
 * filing names no single press release, `unavailable` when a source does not answer with the document.
 */
export const FETCH_ABSTAIN_REASONS = [
	"not-filed",
	"exhibit-not-found",
	"unavailable",
] as const;

/** A figure, or why there is none: a reason of fetching's own, or why the release could not be read. */
export type Outcome =
	| Figure
	| { abstain: AbstainReason | (typeof FETCH_ABSTAIN_REASONS)[number] };

/**
 * The most results filings one run reads: a feed, then an index and a release for each, stays well
 * inside the fifteen HTTP requests the platform allows a workflow execution.
 */
export const MAX_FILINGS = 3;

/** The issuer's EDGAR feed of its ten most recent 8-K filings. */
export function feedUrl(cik: string): string {
	return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=8-K&dateb=&owner=include&count=10&output=atom`;
}

/**
 * The outcome as one canonical string, which is what the nodes reach consensus on. Agreeing on the
 * outcome rather than on the page lets nodes that received the same release with different bytes
 * around it (a header, a reflowed tag) still agree, and leaves no field for them to differ in.
 */
export function encodeOutcome(outcome: Outcome): string {
	return "abstain" in outcome
		? `abstain:${outcome.abstain}`
		: `figure:${outcome.text}`;
}

/** The outcome a canonical string encodes, its figure scaled to `decimals`. */
export function decodeOutcome(encoded: string, decimals: number): Outcome {
	const [kind, body] = [
		encoded.slice(0, encoded.indexOf(":")),
		encoded.slice(encoded.indexOf(":") + 1),
	];
	if (kind === "abstain")
		return {
			abstain: body as Outcome extends { abstain: infer R } ? R : never,
		};
	return scale(body, decimals);
}

/** One node's outcome: find the release, fetch it, read it. */
function fetchOne(
	sendRequester: HTTPSendRequester,
	request: FigureRequest,
): string {
	// A request the capability itself fails, a response over its size limit or a timeout, is a
	// source that did not answer with the document, like any other status.
	const get = (url: string): string | null => {
		let response: ReturnType<
			ReturnType<HTTPSendRequester["sendRequest"]>["result"]
		>;
		try {
			response = sendRequester
				.sendRequest({
					url,
					method: "GET",
					headers: { "User-Agent": request.userAgent },
				})
				.result();
		} catch {
			return null;
		}
		return response.statusCode === 200
			? new TextDecoder().decode(response.body)
			: null;
	};
	const unavailable = encodeOutcome({ abstain: "unavailable" });

	const feed = get(feedUrl(request.cik));
	if (feed === null) return unavailable;
	const filings = releaseFilings(feed, request.notBefore).slice(0, MAX_FILINGS);
	if (filings.length === 0) return encodeOutcome({ abstain: "not-filed" });

	// Earliest first, and the first release that reports the period is the one read: the release
	// first published is the one the terms refer to. Any other failure ends the run, so a later
	// filing is never read in place of one that could not be.
	let outcome: Outcome = { abstain: "period-not-found" };
	for (const filing of filings) {
		const index = get(indexUrl(filing));
		if (index === null) return unavailable;
		const name = exhibitName(index);
		if (name === null) return encodeOutcome({ abstain: "exhibit-not-found" });
		const document = get(documentUrl(filing, name));
		if (document === null) return unavailable;
		outcome = extractFigure(document, request.period, request.decimals);
		if (!("abstain" in outcome) || outcome.abstain !== "period-not-found")
			break;
	}
	return encodeOutcome(outcome);
}

/**
 * The figure the release reports, as the network's nodes agree on it: each node fetches and reads the
 * release itself, and the outcome stands only if they all read the same one.
 */
export function readFigure(
	runtime: Runtime<unknown>,
	request: FigureRequest,
): Outcome {
	const agreed = new HTTPClient()
		.sendRequest(
			runtime,
			fetchOne,
			consensusIdenticalAggregation<string>(),
		)(request)
		.result();
	return decodeOutcome(agreed, request.decimals);
}
