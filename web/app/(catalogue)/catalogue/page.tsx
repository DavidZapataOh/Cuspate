import type { Metadata } from "next";
import { Amount } from "../../../src/ui/Amount.tsx";
import { AmountInput } from "../../../src/ui/AmountInput.tsx";
import { BalanceScale } from "../../../src/ui/BalanceScale.tsx";
import { Button } from "../../../src/ui/Button.tsx";
import { Card } from "../../../src/ui/Card.tsx";
import { ChanceBar } from "../../../src/ui/ChanceBar.tsx";
import { Countdown } from "../../../src/ui/Countdown.tsx";
import { DividedDisc } from "../../../src/ui/DividedDisc.tsx";
import { FilterChips } from "../../../src/ui/FilterChips.tsx";
import { Mark } from "../../../src/ui/Mark.tsx";
import { Notice } from "../../../src/ui/Notice.tsx";
import { OutcomeLabel } from "../../../src/ui/OutcomeLabel.tsx";
import { RuledRow } from "../../../src/ui/RuledRow.tsx";
import { Tabs } from "../../../src/ui/Tabs.tsx";
import { Wordmark } from "../../../src/ui/Wordmark.tsx";
import styles from "./catalogue.module.css";
import { DiscDemo } from "./DiscDemo.tsx";

export const metadata: Metadata = {
	title: "Catalogue - Cuspate",
	robots: { index: false, follow: false },
};

// Rendered per request, so the sample countdown is a real one: eight days, four hours and twelve
// minutes away, and one moment already passed.
export const dynamic = "force-dynamic";
const PAST = "2001-01-01T00:00:00Z";

// The design system, every primitive in every state. Reached by its address only; no page links
// here. All figures are samples.
export default function Catalogue() {
	const soon = new Date(
		Date.now() + ((8 * 24 + 4) * 60 + 12) * 60_000 + 30_000,
	).toISOString();
	return (
		<main className={styles.page}>
			<header className={styles.head}>
				<Wordmark height={18} />
				<h1 className={styles.title}>Design system</h1>
				<p className={styles.lede}>
					Every primitive the interface is built from, in every state. All
					figures are samples.
				</p>
			</header>

			<section className={styles.section} aria-labelledby="identity">
				<h2 id="identity">Mark and wordmark</h2>
				<div
					className={`${styles.row} ${styles.tight}`}
					data-review="on-obsidian"
				>
					<Mark size={16} />
					<Mark size={24} />
					<Mark size={128} />
					<Mark size={16} tone="cream" />
					<Mark size={24} tone="cream" />
					<Mark size={128} tone="cream" />
				</div>
				<div
					className={`${styles.row} ${styles.creamPanel} ${styles.tight}`}
					data-review="on-cream"
				>
					<Mark size={16} tone="obsidian" />
					<Mark size={24} tone="obsidian" />
					<Mark size={128} tone="obsidian" />
					<Wordmark height={20} tone="var(--bg)" />
				</div>
				<div className={`${styles.row} ${styles.tight}`} data-review="wordmark">
					<Wordmark height={14} />
					<Wordmark height={28} />
				</div>
			</section>

			<section className={styles.section} aria-labelledby="disc">
				<h2 id="disc">The divided disc</h2>
				<p className={styles.note}>
					Buying slides the small part along the cut; undoing brings it back;
					the result fades the other world.
				</p>
				<div className={styles.row}>
					<figure className={styles.figure}>
						<DividedDisc state="whole" size={96} />
						<figcaption>Whole</figcaption>
					</figure>
					<figure className={styles.figure}>
						<DividedDisc state="split" size={96} />
						<figcaption>Split</figcaption>
					</figure>
					<figure className={styles.figure}>
						<DividedDisc state="resolved-yes" size={96} />
						<figcaption>They beat</figcaption>
					</figure>
					<figure className={styles.figure}>
						<DividedDisc state="resolved-no" size={96} />
						<figcaption>They didn't</figcaption>
					</figure>
				</div>
				<DiscDemo />
			</section>

			<section className={styles.section} aria-labelledby="balance">
				<h2 id="balance">The balance</h2>
				<BalanceScale
					chance={0.64}
					beat={{ gives: "0.41 TSLA shares", price: 6410n }}
					dont={{ gives: "$500.00 back", price: 3590n }}
				/>
				<div className={styles.split}>
					<Card>
						<BalanceScale
							compact
							chance={0.18}
							beat={{ gives: "0.41 TSLA shares", price: 1800n }}
							dont={{ gives: "$500.00 back", price: 8200n }}
						/>
					</Card>
					<Card>
						<BalanceScale
							compact
							chance={0.5}
							beat={{ gives: "0.41 TSLA shares", price: 5000n }}
							dont={{ gives: "$500.00 back", price: 5000n }}
						/>
					</Card>
				</div>
			</section>

			<section className={styles.section} aria-labelledby="actions">
				<h2 id="actions">Buttons</h2>
				<div className={styles.row}>
					<Button>Buy if they beat</Button>
					<Button variant="secondary">Undo</Button>
					<Button variant="link">or if they don't</Button>
					<Button disabled>Buy if they beat</Button>
					<Button loading>Buying</Button>
				</div>
			</section>

			<section className={styles.section} aria-labelledby="figures">
				<h2 id="figures">Amounts, chances and time</h2>
				<div className={styles.row}>
					<Amount cents={50000n} size={1} />
					<Amount cents={6410n} size={3} tone="beat" />
					<Amount cents={3590n} size={3} tone="dont" />
					<Amount cents={1241050n} size={5} />
				</div>
				<div className={styles.stack}>
					<ChanceBar chance={0.64} />
					<ChanceBar chance={0.18} />
					<ChanceBar chance={0.996} />
				</div>
				<div className={styles.row}>
					<Countdown until={soon} prefix="Freezes in" />
					<Countdown until={PAST} prefix="Freezes" />
				</div>
				<div className={styles.row}>
					<OutcomeLabel outcome="beat" />
					<OutcomeLabel outcome="dont" />
				</div>
			</section>

			<section className={styles.section} aria-labelledby="inputs">
				<h2 id="inputs">Entering an amount</h2>
				<div className={styles.split}>
					<AmountInput />
					<AmountInput defaultValue="500" />
					<AmountInput
						defaultValue="50000"
						error="You need $49,500.00 more. Nothing was charged."
					/>
					<AmountInput defaultValue="500" disabled />
				</div>
			</section>

			<section className={styles.section} aria-labelledby="navigation">
				<h2 id="navigation">Choosing</h2>
				<Tabs
					label="Conditions"
					tabs={[
						{
							id: "beat",
							label: "Beats expectations ($0.54)",
							detail: "64% likely",
						},
						{ id: "50", label: "Above $0.50", detail: "78% likely" },
						{ id: "60", label: "Above $0.60", detail: "41% likely" },
						{ id: "70", label: "Above $0.70", detail: "18% likely" },
					]}
				/>
				<FilterChips
					label="Show"
					options={["All", "This week", "Tech", "Ending soon"]}
				/>
			</section>

			<section className={styles.section} aria-labelledby="messages">
				<h2 id="messages">Messages</h2>
				<div className={styles.stack}>
					<Notice>
						<p>
							Until Oct 21, 4:00 pm ET, you can undo this and get your dollars
							back.
						</p>
					</Notice>
					<Notice tone="error">
						<p>That didn't go through, and nothing moved. Try again.</p>
					</Notice>
				</div>
			</section>

			<section className={styles.section} aria-labelledby="lists">
				<h2 id="lists">Lists</h2>
				<Card>
					<RuledRow
						selected
						title="Beats expectations ($0.54)"
						figure="64%"
						actions={
							<>
								<Button variant="secondary">Beat</Button>
								<Button variant="secondary">Don't</Button>
							</>
						}
					/>
					<RuledRow
						title="Above $0.60"
						figure="41%"
						actions={
							<>
								<Button variant="secondary">Beat</Button>
								<Button variant="secondary">Don't</Button>
							</>
						}
					/>
				</Card>
			</section>
		</main>
	);
}
