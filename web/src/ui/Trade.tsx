"use client";

import { issuer } from "cuspate-shared";
import { useEffect, useState } from "react";
import type { Condition, MarketEvent } from "../data/model.ts";
import { formatShares, formatUsd } from "../lib/format.ts";
import { panLabels } from "../lib/naming.ts";
import {
	amountProblem,
	POOL_FEE_BPS,
	parseAmount,
	preview,
} from "../lib/ticket.ts";
import { announcementEt, announcementUtc } from "../lib/time.ts";
import { feeCents } from "../ticket/order.ts";
import { useTicket } from "../ticket/useTicket.ts";
import { SIGN_IN_PANEL } from "../wallet/SignIn.tsx";
import { AmountInput } from "./AmountInput.tsx";
import { BalanceScale } from "./BalanceScale.tsx";
import { Button } from "./Button.tsx";
import styles from "./Trade.module.css";

const DEFAULT_AMOUNT = "500";
const dripTime = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/New_York",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});
/** The states whose line under the actions is what the buyer acts on, so it reads at full strength. */
const DECISIVE = new Set(["short", "full", "closed", "failed", "done"]);

/**
 * One condition's balance and its ticket, sharing the amount: the pans say what that amount ends
 * as in each world, from the network's quote; until the quote answers, the pan says it is getting a
 * price. Both outcomes are stated before anything is signed; the fee sits beside them.
 */
export function Trade({
	event,
	condition,
	layout,
	side,
	onSideChange,
}: {
	event: Pick<
		MarketEvent,
		"issuer" | "announcesAt" | "spotCents" | "spotPublishedAt"
	>;
	condition: Condition;
	layout: "full" | "compact";
	/** The world bought, when the page holds it (true for the yes world); the ticket's own otherwise. */
	side?: boolean;
	onSideChange?: (yes: boolean) => void;
}) {
	const [text, setText] = useState(DEFAULT_AMOUNT);
	const [ownYes, setOwnYes] = useState(true);
	const yes = side ?? ownYes;
	const setYes = (next: boolean) => {
		setOwnYes(next);
		onSideChange?.(next);
	};
	// Set once the ticket answers to input, so nothing typed before then is lost.
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => setHydrated(true), []);
	const cents = parseAmount(text);
	const ticket = useTicket({ event, condition, amountCents: cents, yes });
	const { view } = ticket;
	const amount = cents ?? 0n;
	const estimate = preview({
		amountCents: amount,
		yesPriceCents: condition.yesWorldPriceCents,
		noPriceCents: condition.noWorldPriceCents,
		yes,
	});
	const quoted = view.state === "preview" ? undefined : ticket.quotedShares;
	// On a live market only the quoter's answer is shown: until it comes, the pan says so.
	const shares =
		quoted !== undefined
			? `${formatShares(quoted)} ${event.issuer} shares`
			: !condition.market || amount === 0n
				? `${formatShares(estimate.shares)} ${event.issuer} shares`
				: view.state === "quoting"
					? "Getting a price..."
					: `${event.issuer} shares at no price now`;
	const back = `${formatUsd(amount)} back`;
	const fee = feeCents(amount);
	const id = `ticket-status-${condition.key}`;
	return (
		<div data-primitive="trade" data-layout={layout} className={styles.trade}>
			<BalanceScale
				compact={layout === "compact"}
				chance={condition.chance}
				labels={panLabels(event, condition)}
				company={issuer(event.issuer).shortName}
				spotCents={event.spotCents}
				spotAt={event.spotPublishedAt || undefined}
				beat={{
					gives: yes ? shares : back,
					price: condition.beatPriceCents,
				}}
				dont={{
					gives: yes ? back : shares,
					price: condition.dontPriceCents,
				}}
			/>
			<div
				data-primitive="ticket"
				data-state={view.state}
				data-hydrated={hydrated || undefined}
				className={styles.ticket}
			>
				<AmountInput
					defaultValue={DEFAULT_AMOUNT}
					onChange={(value) => {
						setText(value);
						ticket.reset();
					}}
					error={
						cents === undefined
							? "Enter an amount in dollars, like 500."
							: undefined
					}
				/>
				<div className={styles.actions}>
					<Button
						disabled={view.buy.disabled}
						loading={view.buy.busy}
						aria-describedby={id}
						popoverTarget={view.buy.signsIn ? SIGN_IN_PANEL : undefined}
						onClick={view.buy.signsIn ? undefined : () => ticket.buy()}
					>
						{view.buy.label}
					</Button>
					<Button
						variant="link"
						disabled={view.buy.busy}
						onClick={() => {
							setYes(!yes);
							ticket.reset();
						}}
					>
						{view.other}
					</Button>
				</div>
				<p className={styles.fine}>
					Fee {(Number(POOL_FEE_BPS) / 100).toFixed(2)}% ({formatUsd(fee)}),
					shown either way.
				</p>
				<p className={styles.fine}>
					Until{" "}
					<time
						dateTime={event.announcesAt}
						title={announcementUtc(event.announcesAt)}
					>
						{announcementEt(event.announcesAt)}
					</time>
					, you can undo this.
				</p>
				<div className={styles.status}>
					<p
						id={id}
						aria-live="polite"
						data-decisive={DECISIVE.has(view.state) || undefined}
					>
						{amountProblem(text) ?? view.status}
					</p>
					{view.offerTestDollars ? (
						ticket.dripLockedUntil ? (
							<p className={styles.fine}>
								This wallet took its test dollars today. It can take more at{" "}
								{dripTime.format(new Date(ticket.dripLockedUntil * 1000))} ET.
							</p>
						) : (
							<Button
								variant="secondary"
								loading={ticket.dripping}
								onClick={() => ticket.getTestDollars()}
							>
								Get test dollars
							</Button>
						)
					) : null}
					{ticket.dripProblem ? (
						<p className={styles.fine} role="alert">
							{ticket.dripProblem}
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
