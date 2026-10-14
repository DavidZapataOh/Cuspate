import type { Metadata } from "next";
import Link from "next/link";
import { readLayer } from "../../src/data/read.ts";
import { formatChance, formatUsd } from "../../src/lib/format.ts";
import { about } from "../../src/lib/issuer.ts";
import {
	addressUrl,
	contracts,
	keys,
	short,
	txUrl,
} from "../../src/lib/keys.ts";
import { formatThreshold } from "../../src/lib/naming.ts";
import {
	announcementEt,
	announcementUtc,
	duration,
} from "../../src/lib/time.ts";
import { Countdown } from "../../src/ui/Countdown.tsx";
import { Figures } from "../../src/ui/Figures.tsx";
import styles from "./disclosures.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Disclosures - Cuspate" };

const sealDay = new Intl.DateTimeFormat("en-US", {
	timeZone: "UTC",
	month: "short",
	day: "numeric",
	year: "numeric",
});

function Address({ value }: { value: string }) {
	return (
		<a className="mono" href={addressUrl(value)}>
			{short(value)}
		</a>
	);
}

export default async function DisclosuresPage() {
	const now = Date.now();
	const read = readLayer();
	const events = (await read.events(now)).filter(
		(e) => Date.parse(e.announcesAt) > now,
	);
	const settlement = await read.settlement();
	const roles = keys();
	const powerful = roles.filter((k) => k.role !== "keeper");
	const owners = [...new Set(powerful.flatMap((k) => k.owners))];
	const named = powerful.map((k) => k.role).join(", ");
	return (
		<main className={styles.page}>
			<header className={styles.head}>
				<h1>Disclosures</h1>
				<p className={styles.lede}>
					What you are using, what can go wrong, and who can do what. Every
					figure on this page is read from the deployment when it loads.
				</p>
			</header>

			<section aria-labelledby="what" className={styles.section}>
				<h2 id="what">What this is</h2>
				<ul className={styles.list}>
					<li>
						This runs on the {settlement.network}. The dollars are test dollars
						and the shares are test tokens minted by our deployer, with no real
						value; nothing can be cashed out.
					</li>
					<li>
						The companies and their earnings dates are real; the tokens named
						after their stock are not their stock and are not issued or endorsed
						by them.
					</li>
					<li>This is not investment advice, an offer or a recommendation.</li>
					<li>
						There is no product fee. Each purchase pays the pools&apos; fee,
						shown in the ticket before you sign.
					</li>
					<li>
						Prices, chances, amounts and the stock price on the market pages are
						read from the test network&apos;s pools, vaults and price feed when
						each page loads.
					</li>
				</ul>
			</section>

			<section aria-labelledby="sealed" className={styles.section}>
				<h2 id="sealed">Thresholds, chances and freezes</h2>
				<p>
					Each threshold is sealed on chain before its market opens and cannot
					change. A condition is met only if the reported figure is above the
					threshold; exactly the threshold does not count. The chance is what
					current prices imply, not a forecast of ours. Buying and undoing stop
					at the freeze, which is the announcement time.
				</p>
				{events.length === 0 ? (
					<p className={styles.muted}>No market is open right now.</p>
				) : (
					events.map((event) => {
						const { company, periodLabel } = about(event);
						return (
							<div key={event.eventKey} className={styles.event}>
								<h3>
									<Link href={`/events/${event.eventKey}`}>
										{company} {periodLabel} earnings
									</Link>
								</h3>
								<p className={styles.muted}>
									Freezes{" "}
									<time
										dateTime={event.announcesAt}
										title={announcementUtc(event.announcesAt)}
									>
										{announcementEt(event.announcesAt)}
									</time>
									{event.dateConfirmed ? "" : " (expected, not yet confirmed)"}
									{" - "}
									<Countdown until={event.announcesAt} prefix="in" />
								</p>
								<table className={styles.table}>
									<thead>
										<tr>
											<th scope="col">Reported figure above</th>
											<th scope="col">Implied chance</th>
											<th scope="col">Sealed</th>
										</tr>
									</thead>
									<tbody>
										{event.conditions.map((c) => (
											<tr key={c.key} data-condition={c.key}>
												<td className="tabular">
													<Figures>{formatThreshold(c)}</Figures>
												</td>
												<td className="tabular">
													<Figures>{formatChance(c.chance)}</Figures>
												</td>
												<td>
													{sealDay.format(new Date(c.sealedAt))}
													{c.sealTx ? (
														<>
															{", "}
															<a className="mono" href={txUrl(c.sealTx)}>
																{short(c.sealTx)}
															</a>
														</>
													) : (
														", not yet on chain"
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						);
					})
				)}
			</section>

			<section aria-labelledby="settle" className={styles.section}>
				<h2 id="settle">How an outcome is decided</h2>
				<p>
					After the company files its earnings release with the SEC, an
					automated Chainlink workflow reads the figure from that filing and
					proposes it on chain with a bond of {formatUsd(settlement.bondCents)}{" "}
					test dollars. Anyone else may propose too. For{" "}
					{duration(settlement.livenessSeconds)} anyone can challenge the figure
					by posting a bond. A challenge goes to the arbiter, who has{" "}
					{duration(settlement.arbiterTimeoutSeconds)} to rule. If nothing can
					be settled within {duration(settlement.expirySeconds)} after the
					deadline, the market resolves invalid and every holder gets half of
					what they hold in each world: half the shares and half the dollars
					kept beside them.
				</p>
			</section>

			<section aria-labelledby="keys" className={styles.section}>
				<h2 id="keys">Who holds the keys</h2>
				<p>
					A few accounts have powers ordinary holders do not. On this test
					deployment each of them is a 1-of-1 multisig wallet, and the {named}{" "}
					{owners.length === 1 ? (
						<>
							are all controlled by one key (
							<Address value={owners[0] ?? ""} />)
						</>
					) : (
						"are controlled by the keys listed below"
					)}
					. Whoever holds {owners.length === 1 ? "that key" : "those keys"}{" "}
					could freeze a market early, or, as arbiter, rule a challenged figure
					wrongly. No account can change a sealed threshold or take a
					holder&apos;s position.
				</p>
				<table className={styles.table}>
					<thead>
						<tr>
							<th scope="col">Role</th>
							<th scope="col">What it can do</th>
							<th scope="col">Account</th>
						</tr>
					</thead>
					<tbody>
						{roles.map((k) => (
							<tr key={k.role} data-role={k.role}>
								<td className={styles.role}>{k.role}</td>
								<td>{k.can}</td>
								<td>
									<Address value={k.address} />
									<span className={styles.muted}>
										{" "}
										{k.threshold} of {k.owners.length}
									</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
				<h3>Contracts</h3>
				<ul className={styles.contracts}>
					{contracts().map((c) => (
						<li key={c.address}>
							<span>{c.name}</span>
							<Address value={c.address} />
						</li>
					))}
				</ul>
			</section>

			<section aria-labelledby="risks" className={styles.section}>
				<h2 id="risks">What could go wrong</h2>
				<ul className={styles.list}>
					<li>
						The contracts are new and have not been audited. A bug could lock or
						lose test funds.
					</li>
					<li>
						The company could report late, restate its figure, or publish it in
						a way that is ambiguous. A challenge delays settlement; an event
						that cannot be settled resolves invalid.
					</li>
					<li>
						The arbiter is one party on this deployment. A wrong ruling would
						pay the wrong side.
					</li>
					<li>
						If few people take the other side, you may not get the size or price
						you want, and undoing before the freeze may return less than you put
						in.
					</li>
					<li>
						The share price you end with after the announcement can be lower
						than what you paid for it.
					</li>
				</ul>
			</section>
		</main>
	);
}
