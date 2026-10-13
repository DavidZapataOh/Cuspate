/**
 * The release each issuer's end-to-end run reads: its most recent earnings release when it was pinned,
 * read live from EDGAR. The feed lists an issuer's ten most recent 8-K filings, so a pinned release
 * eventually drops out of it; the run then fails asking for the pin to be updated, never silently.
 */
import type { Period } from "../resolver-proposer/source";

export type Pinned = {
	ticker: string;
	/** The 8-K that furnished the release. */
	accession: string;
	period: Period;
	/** The announcement the event is sealed with: the morning of the filing day, before any filing. */
	announcesAt: string;
	/** The figure the release prints, as the reader reads it. */
	figure: string;
};

export const PINNED: readonly Pinned[] = [
	{
		ticker: "MU",
		accession: "0000723125-26-000018",
		period: { quarter: 4, fiscalYear: 2026 },
		announcesAt: "2026-09-30T11:00:00Z",
		figure: "33.42",
	},
	{
		ticker: "TSLA",
		accession: "0001628280-26-049213",
		period: { quarter: 2, fiscalYear: 2026 },
		announcesAt: "2026-07-22T11:00:00Z",
		figure: "0.33",
	},
	{
		ticker: "META",
		accession: "0001628280-26-050596",
		period: { quarter: 2, fiscalYear: 2026 },
		announcesAt: "2026-07-29T11:00:00Z",
		figure: "6.18",
	},
	{
		ticker: "HOOD",
		accession: "0001783879-26-000113",
		period: { quarter: 2, fiscalYear: 2026 },
		announcesAt: "2026-07-29T11:00:00Z",
		figure: "0.62",
	},
	{
		ticker: "MSFT",
		accession: "0001193125-26-323632",
		period: { quarter: 4, fiscalYear: 2026 },
		announcesAt: "2026-07-29T11:00:00Z",
		figure: "4.74",
	},
	{
		ticker: "GOOGL",
		accession: "0001652044-26-000066",
		period: { quarter: 2, fiscalYear: 2026 },
		announcesAt: "2026-07-22T11:00:00Z",
		figure: "9.11",
	},
	{
		ticker: "AAPL",
		accession: "0000320193-26-000018",
		period: { quarter: 3, fiscalYear: 2026 },
		announcesAt: "2026-07-30T11:00:00Z",
		figure: "2.02",
	},
	{
		ticker: "AMD",
		accession: "0000002488-26-000121",
		period: { quarter: 2, fiscalYear: 2026 },
		announcesAt: "2026-08-04T11:00:00Z",
		figure: "1.66",
	},
	{
		ticker: "NVDA",
		accession: "0001045810-26-000073",
		period: { quarter: 2, fiscalYear: 2027 },
		announcesAt: "2026-08-26T11:00:00Z",
		figure: "2.22",
	},
	{
		ticker: "WMT",
		accession: "0000104169-26-000145",
		period: { quarter: 2, fiscalYear: 2027 },
		announcesAt: "2026-08-20T11:00:00Z",
		figure: "0.81",
	},
];
