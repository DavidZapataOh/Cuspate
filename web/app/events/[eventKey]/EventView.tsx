"use client";

import { useState } from "react";
import type {
	ChanceHistory,
	MarketEvent,
	Settlement,
} from "../../../src/data/model.ts";
import { formatChance } from "../../../src/lib/format.ts";
import { about } from "../../../src/lib/issuer.ts";
import { buttonWords, conditionTitle } from "../../../src/lib/naming.ts";
import { Button } from "../../../src/ui/Button.tsx";
import { Card } from "../../../src/ui/Card.tsx";
import { LineChart } from "../../../src/ui/LineChart.tsx";
import { RuledRow } from "../../../src/ui/RuledRow.tsx";
import { Trade } from "../../../src/ui/Trade.tsx";
import styles from "./event.module.css";
import { Rules } from "./Rules.tsx";

/** An event's conditions, the chosen one's chance over time and its ticket, then its rules. */
export function EventView({
	event,
	histories,
	settlement,
	initial,
}: {
	event: MarketEvent;
	histories: Record<string, ChanceHistory>;
	settlement: Settlement;
	/** The condition and world the link names, if any: "?c=above-0-43&side=no". */
	initial?: { condition?: string; side?: string };
}) {
	const primary =
		event.conditions.find((c) => c.primary) ?? event.conditions[0];
	const [selectedKey, setSelectedKey] = useState(
		event.conditions.some((c) => c.key === initial?.condition)
			? initial?.condition
			: primary?.key,
	);
	const [yes, setYes] = useState(initial?.side !== "no");
	// The choice is kept in the address, so a reload or a shared link opens the same ticket.
	const choose = (key: string, side: boolean) => {
		setSelectedKey(key);
		setYes(side);
		window.history.replaceState(
			null,
			"",
			`?c=${encodeURIComponent(key)}&side=${side ? "yes" : "no"}`,
		);
	};
	const selected =
		event.conditions.find((c) => c.key === selectedKey) ?? primary;
	if (!selected) return null;
	const title = conditionTitle(event, selected);
	const byThreshold = [...event.conditions].sort((a, b) =>
		a.threshold === b.threshold ? 0 : a.threshold < b.threshold ? -1 : 1,
	);
	return (
		<>
			<div className={styles.layout}>
				<div className={styles.main}>
					<Card as="section" aria-labelledby="chart-title">
						<h2 id="chart-title" className={styles.cardTitle}>
							Chance: {title}
						</h2>
						<LineChart
							points={histories[selected.key]?.points ?? []}
							tradesKnown={histories[selected.key]?.tradesKnown ?? false}
							label={`Chance since the market opened that ${title.toLowerCase()}`}
						/>
					</Card>
					<Card as="section" aria-labelledby="conditions-title">
						<h2 id="conditions-title" className={styles.cardTitle}>
							Conditions on {about(event).company}&apos;s{" "}
							{about(event).figureKind === "non-gaap-diluted-eps"
								? "adjusted EPS"
								: "EPS"}
						</h2>
						<div className={styles.rows}>
							{byThreshold.map((c) => {
								const words = buttonWords(event, c);
								const name = conditionTitle(event, c);
								return (
									<RuledRow
										key={c.key}
										selected={c.key === selected.key}
										title={name}
										figure={`${formatChance(c.chance)} likely`}
										actions={
											<>
												<Button
													variant="secondary"
													aria-pressed={c.key === selected.key && yes}
													aria-label={`${words.yesShort}: ${name}`}
													onClick={() => choose(c.key, true)}
												>
													{words.yesShort}
												</Button>
												<Button
													variant="secondary"
													aria-pressed={c.key === selected.key && !yes}
													aria-label={`${words.noShort}: ${name}`}
													onClick={() => choose(c.key, false)}
												>
													{words.noShort}
												</Button>
											</>
										}
									/>
								);
							})}
						</div>
					</Card>
				</div>
				<aside className={styles.side} aria-labelledby="ticket-title">
					<Card>
						<h2 id="ticket-title" className={styles.cardTitle}>
							Your ticket: {title}
						</h2>
						<Trade
							event={event}
							condition={selected}
							layout="compact"
							side={yes}
							onSideChange={(side) => choose(selected.key, side)}
						/>
					</Card>
				</aside>
			</div>
			<Rules event={event} condition={selected} settlement={settlement} />
		</>
	);
}
