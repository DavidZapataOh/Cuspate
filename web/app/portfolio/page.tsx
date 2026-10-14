import type { Metadata } from "next";
import Link from "next/link";
import { getAddress, isAddress } from "viem";
import { rpcUrl } from "../../src/chain/endpoint.ts";
import { chainClient } from "../../src/chain/market.ts";
import { readLayer } from "../../src/data/read.ts";
import { conditionTitle } from "../../src/lib/naming.ts";
import { positionsOf } from "../../src/portfolio/chain.ts";
import { listedMarkets } from "../../src/portfolio/listed.ts";
import { holdsAny, type Position } from "../../src/portfolio/position.ts";
import { Notice } from "../../src/ui/Notice.tsx";
import { AccountGate } from "./AccountGate.tsx";
import { PositionCard } from "./PositionCard.tsx";
import styles from "./portfolio.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Portfolio - Cuspate" };

type Props = { searchParams: Promise<{ address?: string | string[] }> };

/** The condition's name, from the event's own terms where the read layer has them. */
async function titleOf(position: Position, now: number): Promise<string> {
	const event = await readLayer().event(position.eventKey, now);
	const condition = event?.conditions.find(
		(c) => c.key === position.conditionKey,
	);
	return event && condition
		? conditionTitle(event, condition)
		: position.conditionKey;
}

export default async function PortfolioPage({ searchParams }: Props) {
	const { address } = await searchParams;
	const raw = typeof address === "string" ? address : undefined;
	const owner = raw && isAddress(raw) ? getAddress(raw) : undefined;
	let positions: Position[] | undefined;
	let failed = false;
	if (owner) {
		try {
			positions = (
				await positionsOf(chainClient(rpcUrl()), owner, listedMarkets())
			).filter((p) => holdsAny(p.holdings));
		} catch {
			failed = true;
		}
	}
	const now = Date.now();
	const titles = positions
		? await Promise.all(positions.map((p) => titleOf(p, now)))
		: [];
	return (
		<main className={styles.page} data-screen="portfolio">
			<header className={styles.lead}>
				<h1 className={styles.headline}>Portfolio</h1>
				<p className={styles.explain}>
					Each position is a share of the stock in the world where the condition
					holds, and your dollars in the world where it does not. Undo it before
					the announcement, or redeem it once the figure is reported.
				</p>
			</header>
			<AccountGate owner={owner} />
			{raw && !owner ? (
				<Notice tone="error">
					<p>That is not an address. Check it and try again.</p>
				</Notice>
			) : null}
			{failed ? (
				<Notice tone="error">
					<p>
						The test network did not answer, so your positions could not be
						read. Reload the page to try again.
					</p>
				</Notice>
			) : null}
			{positions && positions.length === 0 ? (
				<div className={styles.empty} data-state="empty">
					<p>No positions yet.</p>
					<Link href="/">See the open markets</Link>
				</div>
			) : null}
			{positions && positions.length > 0 ? (
				<ul className={styles.list}>
					{positions.map((p, i) => (
						<li key={p.marketId}>
							<PositionCard position={p} title={titles[i] ?? p.conditionKey} />
						</li>
					))}
				</ul>
			) : null}
		</main>
	);
}
