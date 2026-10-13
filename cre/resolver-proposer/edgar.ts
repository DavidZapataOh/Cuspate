/**
 * Finds an issuer's earnings release on SEC EDGAR before it is read. A release's address is not known
 * until it is filed, so the workflow looks for it where EDGAR lists it: the issuer's feed of recent
 * 8-K filings, then the index of the filing that reports results, which names its exhibits.
 *
 * Pure functions of the documents fetched, like the parser, so every node finds the same release.
 */

/** A filing EDGAR lists: its accession number, the date it was filed, and the issuer's CIK. */
export type Filing = { accession: string; filed: string; cik: string };

const ENTRY = /<entry>([\s\S]*?)<\/entry>/g;
// Item 2.02 of Form 8-K is "Results of Operations and Financial Condition", the item an earnings
// release is furnished under.
const RESULTS_ITEM = /\b2\.02\b/;
// Exhibit 99.1 under the names filers give it: ex99-1, ex991, exhibit99_1, ex-99.1, with any prefix
// and suffix, but never 99.10 or a bare 99.
const EXHIBIT_99_1 = /ex(?:hibit)?[-_.]?99[-_.]?0?1(?![0-9])[^/]*\.html?$/i;

function field(entry: string, name: string): string | undefined {
	return new RegExp(`<${name}>([^<]*)</${name}>`).exec(entry)?.[1].trim();
}

/**
 * The issuer's earnings releases filed on or after `notBefore`, earliest first. Amendments are left
 * out: the release first published is the one the terms refer to, and a restatement does not
 * change an outcome.
 * @param feed The issuer's EDGAR feed of 8-K filings, Atom.
 * @param notBefore The first date a release for the event can carry, `YYYY-MM-DD`.
 */
export function releaseFilings(feed: string, notBefore: string): Filing[] {
	const filings: Filing[] = [];
	for (const [, entry] of feed.matchAll(ENTRY)) {
		const accession = field(entry, "accession-number");
		const filed = field(entry, "filing-date");
		const cik = /\/edgar\/data\/(\d+)\//.exec(
			field(entry, "filing-href") ?? "",
		)?.[1];
		if (
			field(entry, "filing-type") !== "8-K" ||
			!RESULTS_ITEM.test(field(entry, "items-desc") ?? "")
		)
			continue;
		if (
			accession === undefined ||
			filed === undefined ||
			cik === undefined ||
			filed < notBefore
		)
			continue;
		filings.push({ accession, filed, cik: String(Number(cik)) });
	}
	return filings.sort((a, b) =>
		a.filed === b.filed
			? a.accession.localeCompare(b.accession)
			: a.filed.localeCompare(b.filed),
	);
}

/** Where EDGAR keeps a filing's index of documents. */
export function indexUrl(filing: Filing): string {
	return `https://www.sec.gov/Archives/edgar/data/${filing.cik}/${filing.accession.replaceAll("-", "")}/index.json`;
}

/** Where EDGAR keeps one of a filing's documents. */
export function documentUrl(filing: Filing, name: string): string {
	return `https://www.sec.gov/Archives/edgar/data/${filing.cik}/${filing.accession.replaceAll("-", "")}/${name}`;
}

/**
 * The name of the filing's exhibit 99.1, the press release, or null when the index lists none or
 * more than one, since then which document is the release is a guess.
 * @param index The filing's `index.json`.
 */
export function exhibitName(index: string): string | null {
	let items: unknown;
	try {
		items = JSON.parse(index)?.directory?.item;
	} catch {
		return null;
	}
	if (!Array.isArray(items)) return null;
	const names = items
		.map((item) => (typeof item?.name === "string" ? item.name : ""))
		.filter((name) => EXHIBIT_99_1.test(name));
	return names.length === 1 ? names[0] : null;
}
