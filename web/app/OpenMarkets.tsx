"use client";

import Link from "next/link";
import { useState } from "react";
import type { MarketEvent } from "../src/data/model.ts";
import { FILTERS, type Filter, filterEvents } from "../src/lib/events.ts";
import { formatUsd } from "../src/lib/format.ts";
import { about } from "../src/lib/issuer.ts";
import { conditionTitle } from "../src/lib/naming.ts";
import { announcementEt, announcementUtc } from "../src/lib/time.ts";
import { ChanceBar } from "../src/ui/ChanceBar.tsx";
import { Countdown } from "../src/ui/Countdown.tsx";
import { Figures } from "../src/ui/Figures.tsx";
import { FilterChips } from "../src/ui/FilterChips.tsx";
import { SearchField } from "../src/ui/SearchField.tsx";
import styles from "./home.module.css";

/** Every open event, narrowed by a chip and a search, one card each, in the order they freeze. */
export function OpenMarkets({
	events,
	now,
}: {
	events: MarketEvent[];
	now: number;
}) {
	const [filter, setFilter] = useState<Filter>("All");
	const [query, setQuery] = useState("");
	const shown = filterEvents(events, filter, query, now);
	return (
		<section className={styles.markets} aria-labelledby="markets-title">
			<h2 id="markets-title" className={styles.marketsTitle}>
				Open markets
			</h2>
			<div className={styles.controls}>
				<FilterChips
					label="Show"
					options={[...FILTERS]}
					selected={filter}
					onSelect={(option) => setFilter(option as Filter)}
				/>
				<div className={styles.search}>
					<SearchField
						label="Search markets"
						placeholder="Search markets"
						value={query}
						onChange={setQuery}
					/>
				</div>
			</div>
			{shown.length === 0 ? (
				<p className={styles.empty}>No open market matches that.</p>
			) : (
				<ul className={styles.grid}>
					{shown.map((event) => {
						const primary = event.conditions.find((c) => c.primary);
						return (
							<li key={event.eventKey} data-event={event.eventKey}>
								<Link
									href={`/events/${event.eventKey}`}
									className={styles.card}
								>
									<span className={styles.cardHead}>
										<span className={styles.company}>
											{about(event).company}
										</span>
										<span className={styles.ticker}>{event.issuer}</span>
									</span>
									{primary ? (
										<span className={styles.condition}>
											{conditionTitle(event, primary)}
										</span>
									) : null}
									<span className={styles.meta}>
										<time
											dateTime={event.announcesAt}
											title={announcementUtc(event.announcesAt)}
										>
											{announcementEt(event.announcesAt)}
										</time>
										<span aria-hidden="true"> - </span>
										<Countdown until={event.announcesAt} prefix="in" />
									</span>
									{primary ? <ChanceBar chance={primary.chance} /> : null}
									<span className={styles.foot}>
										<span>{event.conditions.length} conditions</span>
										<span>
											<Figures>{formatUsd(event.moneyIn)}</Figures> test dollars
											in
										</span>
									</span>
								</Link>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
