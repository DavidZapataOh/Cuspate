import Link from "next/link";
import { readLayer } from "../src/data/read.ts";
import { pickFeatured } from "../src/lib/events.ts";
import { about } from "../src/lib/issuer.ts";
import { headline } from "../src/lib/naming.ts";
import { announcementEt, announcementUtc } from "../src/lib/time.ts";
import { Countdown } from "../src/ui/Countdown.tsx";
import { Trade } from "../src/ui/Trade.tsx";
import styles from "./home.module.css";
import { OpenMarkets } from "./OpenMarkets.tsx";

// Read on every request: the markets move, and nothing is read from the chain at build time.
export const dynamic = "force-dynamic";

export default async function Home() {
	const now = Date.now();
	const events = await readLayer().events(now);
	const featured = pickFeatured(events, now);
	const primary = featured?.conditions.find((c) => c.primary);
	return (
		<main className={styles.page}>
			{featured && primary ? (
				<section className={styles.featured} aria-labelledby="featured-title">
					<div className={styles.lead}>
						<h1 id="featured-title" className={styles.headline}>
							{headline(featured, primary)}
						</h1>
						<p className={styles.explain}>
							If it happens, you own the shares. If it doesn't, you get your
							dollars back.
						</p>
						<p className={styles.when}>
							<Countdown until={featured.announcesAt} prefix="Freezes in" />
							<span aria-hidden="true"> - </span>
							{about(featured).company} reports{" "}
							<time
								dateTime={featured.announcesAt}
								title={announcementUtc(featured.announcesAt)}
							>
								{announcementEt(featured.announcesAt)}
							</time>
							.{" "}
							<Link href={`/events/${featured.eventKey}`}>
								All {featured.conditions.length} conditions
							</Link>
						</p>
					</div>
					<Trade event={featured} condition={primary} layout="full" />
				</section>
			) : (
				<section className={styles.featured}>
					<h1 className={styles.headline}>No conditions open right now.</h1>
				</section>
			)}
			<OpenMarkets events={events} now={now} />
		</main>
	);
}
