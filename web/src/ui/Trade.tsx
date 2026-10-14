"use client";

import { issuer } from "cuspate-shared";
import { useEffect, useState } from "react";
import type { Condition, MarketEvent } from "../data/model.ts";
import { formatShares, formatUsd } from "../lib/format.ts";
import { panLabels } from "../lib/naming.ts";
import { POOL_FEE_BPS, parseAmount, preview } from "../lib/ticket.ts";
import { announcementEt, announcementUtc } from "../lib/time.ts";
import { feeCents } from "../ticket/order.ts";
import { useTicket } from "../ticket/useTicket.ts";
import { SIGN_IN_PANEL } from "../wallet/SignIn.tsx";
import { AmountInput } from "./AmountInput.tsx";
import { BalanceScale } from "./BalanceScale.tsx";
import { Button } from "./Button.tsx";
import styles from "./Trade.module.css";

const DEFAULT_AMOUNT = "500";
/** The states whose line under the actions is what the buyer acts on, so it reads at full strength. */
const DECISIVE = new Set(["short", "full", "closed", "failed", "done"]);

/**
 * One condition's balance and its ticket, sharing the amount: the pans say what that amount ends
 * as in each world, from the network's quote once the market is open on chain and from the sample
 * prices before. Both outcomes are stated before anything is signed; the fee sits beside them.
 */
export function Trade({
	event,
	condition,
	layout,
}: {
	event: Pick<MarketEvent, "issuer" | "announcesAt" | "spotCents">;
	condition: Condition;
	layout: "full" | "compact";
}) {
	const [text, setText] = useState(DEFAULT_AMOUNT);
	const [yes, setYes] = useState(true);
	// Set once the ticket answers to input, so nothing typed before then is lost.
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => setHydrated(true), []);
	const cents = parseAmount(text);
	const ticket = useTicket({ event, condition, amountCents: cents, yes });
	const { view } = ticket;
	const amount = cents ?? 0n;
	const sample = preview({
		amountCents: amount,
		yesPriceCents: condition.yesWorldPriceCents,
		noPriceCents: condition.noWorldPriceCents,
		yes,
	});
	const quoted = view.state === "preview" ? undefined : ticket.quotedShares;
	const shares = `${formatShares(quoted ?? sample.shares)} ${event.issuer} shares`;
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
						{view.status}
					</p>
					{view.offerTestDollars ? (
						<Button
							variant="secondary"
							loading={ticket.dripping}
							onClick={() => ticket.getTestDollars()}
						>
							Get test dollars
						</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}
