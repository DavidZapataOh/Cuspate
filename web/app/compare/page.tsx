import type { Metadata } from "next";
import { readLayer } from "../../src/data/read.ts";
import { about } from "../../src/lib/issuer.ts";
import { formatThreshold } from "../../src/lib/naming.ts";
import { Calculator, type Choice } from "./Calculator.tsx";
import styles from "./compare.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Compare - Cuspate" };

export default async function ComparePage() {
	const now = Date.now();
	const read = readLayer();
	const events = (await read.events(now)).filter(
		(e) => Date.parse(e.announcesAt) > now,
	);
	const choices: Choice[] = events.flatMap((event) => {
		const { company, periodLabel } = about(event);
		return event.conditions.map((c) => ({
			key: `${event.eventKey}/${c.key}`,
			label: `${company} ${periodLabel}: reported figure above ${formatThreshold(c)}`,
			ticker: event.issuer,
			spotCents: event.spotCents.toString(),
			metWorldPriceCents: c.yesWorldPriceCents.toString(),
			primary: c.primary,
		}));
	});
	const first = choices.find((c) => c.primary) ?? choices[0];
	return (
		<main className={styles.page}>
			<header className={styles.head}>
				<h1>Compare</h1>
				<p className={styles.lede}>
					Put the same dollars three ways: into the stock now, into a purchase
					that happens only if the condition is met, and into a call option you
					price yourself. See what each holds after the announcement, at a share
					price you choose.
				</p>
			</header>
			{first ? (
				<Calculator choices={choices} initial={first.key} />
			) : (
				<p className={styles.muted}>No market is open right now.</p>
			)}
			<section className={styles.notes} aria-labelledby="sources">
				<h2 id="sources">Where the numbers come from</h2>
				<ul>
					<li>
						The stock price is the test network&apos;s price feed for the test
						share, read when this page loads.
					</li>
					<li>
						The price of a share if the condition is met comes from the
						market&apos;s pools, read when this page loads, less the pools&apos;
						fee.
						{read.synthetic
							? " Until the markets open these are sample prices."
							: null}
					</li>
					<li>
						We do not show exchange option prices. Bring a call option&apos;s
						price and strike from your broker; the calculator uses only what you
						enter, and leaves out its commissions and expiry date.
					</li>
					<li>
						These are illustrations on a test network, not advice or quotes.
					</li>
				</ul>
			</section>
		</main>
	);
}
