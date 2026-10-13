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
// A row of the index's document table, and the cells it holds.
const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL = /<td[^>]*>([\s\S]*?)<\/td>/gi;
const HREF = /href="[^"]*\/([^"/]+)"/i;

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

/**
 * Where EDGAR keeps a filing's index page, which lists each document with the type the filer declared
 * for it: the exhibit is chosen by that type, since filers name the file anything.
 */
export function indexUrl(filing: Filing): string {
	return `https://www.sec.gov/Archives/edgar/data/${filing.cik}/${filing.accession.replaceAll("-", "")}/${filing.accession}-index.html`;
}

/** Where EDGAR keeps one of a filing's documents. */
export function documentUrl(filing: Filing, name: string): string {
	return `https://www.sec.gov/Archives/edgar/data/${filing.cik}/${filing.accession.replaceAll("-", "")}/${name}`;
}

/**
 * The name of the filing's exhibit 99.1, the press release, or null when the index lists none or
 * more than one, since then which document is the release is a guess. The document table's fourth
 * column is the type the filer declared; the description column is free text and is not read.
 * @param index The filing's index page, HTML.
 */
export function exhibitName(index: string): string | null {
	const names: string[] = [];
	for (const [, row] of index.matchAll(ROW)) {
		const cells = [...row.matchAll(CELL)].map(([, cell]) => cell);
		if (cells.length < 4 || cells[3].trim() !== "EX-99.1") continue;
		const name = HREF.exec(cells[2])?.[1];
		if (name) names.push(name);
	}
	return names.length === 1 ? names[0] : null;
}
