import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readLayer } from "../../../src/data/read.ts";
import { formatUsd } from "../../../src/lib/format.ts";
import { about } from "../../../src/lib/issuer.ts";
import { announcementEt, announcementUtc } from "../../../src/lib/time.ts";
import { Countdown } from "../../../src/ui/Countdown.tsx";
import { Figures } from "../../../src/ui/Figures.tsx";
import { EventView } from "./EventView.tsx";
import styles from "./event.module.css";

export const dynamic = "force-dynamic";

type Params = {
	params: Promise<{ eventKey: string }>;
	searchParams?: Promise<{ c?: string | string[]; side?: string | string[] }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
	const { eventKey } = await params;
	const event = await readLayer().event(eventKey, Date.now());
	return {
		title: event
			? `${about(event).company} ${about(event).periodLabel} earnings - Cuspate`
			: "Cuspate",
	};
}

export default async function EventPage({ params, searchParams }: Params) {
	const { eventKey } = await params;
	const query = (await searchParams) ?? {};
	const one = (v: string | string[] | undefined) =>
		typeof v === "string" ? v : undefined;
	const now = Date.now();
	const read = readLayer();
	const event = await read.event(eventKey, now);
	if (!event) notFound();
	const histories = Object.fromEntries(
		await Promise.all(
			event.conditions.map(
				async (c) =>
					[c.key, await read.history(event.eventKey, c.key, now)] as const,
			),
		),
	);
	const settlement = await read.settlement();
	return (
		<main className={styles.page}>
			<nav aria-label="Breadcrumb" className={styles.crumbs}>
				<Link href="/">Markets</Link>
				<span aria-hidden="true">/</span>
				<span aria-current="page">{about(event).company}</span>
			</nav>
			<header className={styles.head}>
				<h1 className={styles.title}>
					{about(event).company} {about(event).periodLabel} earnings
				</h1>
				<p className={styles.meta}>
					<span>
						Reports{" "}
						<time
							dateTime={event.announcesAt}
							title={announcementUtc(event.announcesAt)}
						>
							{announcementEt(event.announcesAt)}
						</time>
						{event.dateConfirmed
							? ""
							: " (expected; not yet confirmed by the company)"}
					</span>
					<Countdown until={event.announcesAt} prefix="Freezes in" />
					<span>
						<Figures>{formatUsd(event.moneyIn)}</Figures> test dollars in
					</span>
				</p>
			</header>
			<EventView
				event={event}
				histories={histories}
				settlement={settlement}
				initial={{ condition: one(query.c), side: one(query.side) }}
			/>
		</main>
	);
}
