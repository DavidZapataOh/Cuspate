import type {
	Condition,
	MarketEvent,
	Settlement,
} from "../../../src/data/model.ts";
import { formatUsd } from "../../../src/lib/format.ts";
import { about } from "../../../src/lib/issuer.ts";
import { formatThreshold } from "../../../src/lib/naming.ts";
import {
	announcementEt,
	announcementUtc,
	duration,
} from "../../../src/lib/time.ts";
import styles from "./event.module.css";

const sealDay = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	month: "short",
	day: "numeric",
	year: "numeric",
});

function short(address: string): string {
	return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** How a condition is settled, said plainly, every figure from the data. */
export function Rules({
	event,
	condition,
	settlement,
}: {
	event: MarketEvent;
	condition: Condition;
	settlement: Settlement;
}) {
	const value = formatThreshold(condition);
	const { company, figureKind, periodLabel, periodEnd } = about(event);
	const adjusted = figureKind === "non-gaap-diluted-eps";
	const figure = adjusted
		? "adjusted (non-GAAP) diluted earnings per share"
		: "diluted earnings per share as reported under GAAP";
	return (
		<section className={styles.rules} aria-labelledby="rules-title">
			<h2 id="rules-title">Rules</h2>
			<p>
				This condition is met if {company}&apos;s {figure} for {periodLabel}{" "}
				(the period ending {periodEnd}), as published in its earnings release
				filed with the SEC, is above {value}. Exactly {value} does not count.
				{adjusted
					? null
					: ` ${company} publishes no adjusted figure, so the reported number decides, one-off items included.`}
			</p>
			<p>
				The threshold was sealed on chain on{" "}
				{sealDay.format(new Date(condition.sealedAt))} and cannot change.{" "}
				{condition.sealTx
					? `Sealing transaction: ${short(condition.sealTx)}.`
					: "The sealing transaction is listed here once the market is live."}
			</p>
			<p>
				Trading freezes at the announcement,{" "}
				<time
					dateTime={event.announcesAt}
					title={announcementUtc(event.announcesAt)}
				>
					{announcementEt(event.announcesAt)}
				</time>
				. After the release, the figure is proposed on chain with a bond of{" "}
				{formatUsd(settlement.bondCents)} and can be challenged for{" "}
				{duration(settlement.livenessSeconds)}. A Chainlink workflow that reads
				the filing is one proposer; anyone can propose or challenge. A challenge
				goes to the arbiter (
				<span className="mono">{short(settlement.arbiter)}</span>), who has{" "}
				{duration(settlement.arbiterTimeoutSeconds)} to rule. Then holders
				redeem.
			</p>
			<p>
				If the figure cannot be settled within{" "}
				{duration(settlement.expirySeconds)} after the deadline, the market
				resolves invalid and every holder gets their share back.
			</p>
			<h3>What could go wrong</h3>
			<p>
				On the {settlement.network}, the shares are test tokens minted by our
				deployer and have no value. A guardian (
				<span className="mono">{short(settlement.guardian)}</span>) can freeze
				trading early if something breaks. The company could report late or
				restate its figure, and a challenge delays settlement. If few people
				take the other side, you may not get the size you want.
			</p>
		</section>
	);
}
