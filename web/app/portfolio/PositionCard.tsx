"use client";

import { issuer as profileOf } from "cuspate-shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePublicClient } from "wagmi";
import { checkPurchase } from "../../src/chain/market.ts";
import { contracts } from "../../src/chain/record.ts";
import { formatUsd } from "../../src/lib/format.ts";
import { announcementEt } from "../../src/lib/time.ts";
import { quoteUndo } from "../../src/portfolio/chain.ts";
import {
	dollarUnitsToCents,
	formatUnits4,
	type Position,
	phaseOf,
	redeemCalls,
	settlementOf,
	undoCalls,
	undoDollars,
	worldOf,
} from "../../src/portfolio/position.ts";
import { usePositionSender } from "../../src/portfolio/sender.tsx";
import { problemText } from "../../src/ticket/problems.ts";
import { Button } from "../../src/ui/Button.tsx";
import { Card } from "../../src/ui/Card.tsx";
import { Countdown } from "../../src/ui/Countdown.tsx";
import { Notice } from "../../src/ui/Notice.tsx";
import styles from "./portfolio.module.css";

const SHARE_DECIMALS = 18;

function companyOf(issuer: string): string {
	try {
		return profileOf(issuer).shortName;
	} catch {
		return issuer;
	}
}

function usd(units: bigint): string {
	return formatUsd(dollarUnitsToCents(units));
}

type Status =
	| { kind: "idle" }
	| { kind: "busy"; what: string }
	| { kind: "done"; text: string }
	| { kind: "error"; text: string };

/** One position: what it holds in each world, where it stands, and the one thing to do with it. */
export function PositionCard({
	position,
	title,
}: {
	position: Position;
	title: string;
}) {
	const router = useRouter();
	const client = usePublicClient();
	const sender = usePositionSender();
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const phase = phaseOf(position, Math.floor(Date.now() / 1000));
	const company = companyOf(position.issuer);
	const yes = worldOf(position.holdings);
	const h = position.holdings;
	const shares = yes ? h.underlyingYes : h.underlyingNo;
	const kept = yes ? h.dollarNo : h.dollarYes;
	const freezeIso =
		position.freezesAt > 0
			? new Date(position.freezesAt * 1000).toISOString()
			: undefined;
	const mine =
		sender && sender.account.toLowerCase() === position.holder.toLowerCase();

	async function run(
		what: string,
		build: () => Promise<{
			calls: Parameters<typeof checkPurchase>[2];
			done: string;
		}>,
	) {
		if (!sender || !client) return;
		setStatus({ kind: "busy", what });
		try {
			const { calls, done } = await build();
			const problem = await checkPurchase(client, sender.account, calls);
			if (problem) {
				setStatus({ kind: "error", text: problemText(problem) });
				return;
			}
			const settled = await sender.executor.settle(
				await sender.executor.send(calls),
			);
			if (settled.status !== "confirmed") {
				setStatus({
					kind: "error",
					text: "That didn't go through, and nothing moved. Try again.",
				});
				return;
			}
			setStatus({ kind: "done", text: done });
			router.refresh();
		} catch (error) {
			setStatus({
				kind: "error",
				text:
					error instanceof Error && error.message.startsWith("trading")
						? "Trading has closed for this event."
						: "That didn't go through, and nothing moved. Try again.",
			});
		}
	}

	const undo = () =>
		run("undo", async () => {
			if (!client || !sender) throw new Error("not signed in");
			const quoted = await quoteUndo(client, position);
			if (quoted === undefined)
				throw new Error("trading has closed or the pool refused the sale");
			return {
				calls: undoCalls({
					router: contracts.router,
					position,
					recipient: sender.account,
					quotedOut: quoted,
					nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
				}),
				done: `Undone. About ${usd(undoDollars(position, quoted))} is back in your wallet.`,
			};
		});

	const redeem = () =>
		run("redeem", async () => ({
			calls: redeemCalls(position),
			done: "Redeemed. The payout is in your wallet.",
		}));

	const settlement = settlementOf(position);
	const busy = status.kind === "busy";

	return (
		<Card
			as="article"
			className={styles.card}
			data-phase={phase}
			data-outcome={position.outcome}
			aria-labelledby={`p-${position.marketId}`}
		>
			<div className={styles.top}>
				<div>
					<p className={styles.company}>{company}</p>
					<h2 id={`p-${position.marketId}`} className={styles.title}>
						{title}
					</h2>
				</div>
				<p className={styles.phase} data-phase-label>
					{phase === "open"
						? "Open"
						: phase === "frozen"
							? "Waiting for the figure"
							: position.outcome === "invalid"
								? "Resolved invalid"
								: "Resolved"}
				</p>
			</div>

			<dl className={styles.worlds}>
				<div>
					<dt>{yes ? "If it holds" : "If it does not hold"}</dt>
					<dd className="tabular">
						{formatUnits4(shares, SHARE_DECIMALS)} {position.issuer} shares
					</dd>
				</div>
				<div>
					<dt>{yes ? "If it does not hold" : "If it holds"}</dt>
					<dd className="tabular">{usd(kept)} back</dd>
				</div>
			</dl>

			{phase === "open" && freezeIso ? (
				<div className={styles.action}>
					<p className={styles.when}>
						<Countdown until={freezeIso} prefix="Trading closes in" />
						<span> at the announcement, {announcementEt(freezeIso)}.</span>
					</p>
					{mine ? (
						<Button variant="secondary" loading={busy} onClick={undo}>
							Undo this position
						</Button>
					) : null}
				</div>
			) : null}

			{phase === "frozen" ? (
				<p className={styles.when}>
					Trading closed at the announcement. The position settles once the
					reported figure is confirmed; nothing to do until then.
				</p>
			) : null}

			{phase === "settled" ? (
				<div className={styles.action}>
					<p className={styles.when}>
						{position.outcome === "invalid"
							? "The event could not be settled, so every leg pays half: "
							: position.outcome === (yes ? "yes" : "no")
								? "It went your way: "
								: "It did not go your way: "}
						<span className="tabular">
							{settlement.shares > 0n
								? `${formatUnits4(settlement.shares, SHARE_DECIMALS)} ${position.issuer} shares`
								: ""}
							{settlement.shares > 0n && settlement.dollars > 0n ? " and " : ""}
							{settlement.dollars > 0n ? usd(settlement.dollars) : ""}
							{settlement.shares === 0n && settlement.dollars === 0n
								? "nothing to collect"
								: ""}
						</span>
						.
					</p>
					{mine ? (
						<Button variant="primary" loading={busy} onClick={redeem}>
							{settlement.shares === 0n && settlement.dollars === 0n
								? "Clear this position"
								: "Redeem"}
						</Button>
					) : null}
				</div>
			) : null}

			{status.kind === "done" ? (
				<Notice>
					<p>{status.text}</p>
				</Notice>
			) : null}
			{status.kind === "error" ? (
				<Notice tone="error">
					<p>{status.text}</p>
				</Notice>
			) : null}
		</Card>
	);
}
