"use client";

import { useId, useState } from "react";
import { outcomes, roundCents } from "../../src/lib/compare.ts";
import { formatShares, formatUsd } from "../../src/lib/format.ts";
import { parseAmount } from "../../src/lib/ticket.ts";
import { AmountInput } from "../../src/ui/AmountInput.tsx";
import { Figures } from "../../src/ui/Figures.tsx";
import styles from "./compare.module.css";

/** One condition the visitor can compare, its prices as decimal strings of cents. */
export type Choice = {
	key: string;
	label: string;
	ticker: string;
	spotCents: string;
	metWorldPriceCents: string;
	primary: boolean;
};

function dollars(cents: bigint): string {
	return formatUsd(cents).slice(1);
}

/** The three ways side by side, recomputed on every keystroke from the prices read on load. */
export function Calculator({
	choices,
	initial,
}: {
	choices: Choice[];
	initial: string;
}) {
	const selectId = useId();
	const [key, setKey] = useState(initial);
	const choice = choices.find((c) => c.key === key) ?? choices[0];
	const spotCents = BigInt(choice?.spotCents ?? "0");
	const [amount, setAmount] = useState("1000");
	const [after, setAfter] = useState<string | undefined>(undefined);
	const [premium, setPremium] = useState("");
	const [strike, setStrike] = useState("");
	if (!choice) return null;

	const amountCents = parseAmount(amount);
	const afterCents = after === undefined ? spotCents : parseAmount(after);
	const premiumCents = premium ? parseAmount(premium) : undefined;
	const strikeCents = strike ? parseAmount(strike) : undefined;
	const result =
		amountCents !== undefined && amountCents > 0n && afterCents !== undefined
			? outcomes({
					amountCents,
					spotCents,
					metWorldPriceCents: BigInt(choice.metWorldPriceCents),
					afterCents,
					premiumCents,
					strikeCents,
				})
			: undefined;
	const optionReady =
		premiumCents !== undefined &&
		premiumCents > 0n &&
		strikeCents !== undefined;

	return (
		<section className={styles.calc} aria-labelledby="calc-title">
			<h2 id="calc-title" className={styles.visuallyHidden}>
				Calculator
			</h2>
			<div className={styles.inputs}>
				<div className={styles.field}>
					<label htmlFor={selectId}>Condition</label>
					<select
						id={selectId}
						value={key}
						onChange={(e) => {
							setKey(e.target.value);
							setAfter(undefined);
						}}
					>
						{choices.map((c) => (
							<option key={c.key} value={c.key}>
								{c.label}
							</option>
						))}
					</select>
				</div>
				<AmountInput
					label="Amount"
					defaultValue={amount}
					onChange={setAmount}
					error={
						amountCents === undefined
							? "Enter an amount in dollars."
							: undefined
					}
				/>
				<AmountInput
					key={`after-${key}`}
					label={`${choice.ticker} price after the report`}
					defaultValue={dollars(spotCents)}
					onChange={setAfter}
					error={
						afterCents === undefined ? "Enter a price in dollars." : undefined
					}
				/>
				<AmountInput
					label="Call option price, per share"
					defaultValue=""
					onChange={setPremium}
					error={
						premium && premiumCents === undefined
							? "Enter a price in dollars."
							: undefined
					}
				/>
				<AmountInput
					label="Call option strike"
					defaultValue=""
					onChange={setStrike}
					error={
						strike && strikeCents === undefined
							? "Enter a price in dollars."
							: undefined
					}
				/>
			</div>

			<table className={styles.table} data-compare="result">
				<thead>
					<tr>
						<th scope="col">Way</th>
						<th scope="col">If the condition is met</th>
						<th scope="col">If it is not</th>
					</tr>
				</thead>
				<tbody>
					<tr data-way="stock">
						<th scope="row">
							Buy {choice.ticker} now at{" "}
							<span className="tabular">
								<Figures>{formatUsd(spotCents)}</Figures>
							</span>
						</th>
						<td>
							{result ? (
								<>
									<span className="tabular">
										<Figures>{formatShares(result.stockShares)}</Figures>
									</span>{" "}
									shares, worth{" "}
									<span className="tabular">
										<Figures>
											{formatUsd(roundCents(result.stockValueCents))}
										</Figures>
									</span>
								</>
							) : (
								"-"
							)}
						</td>
						<td>{result ? "The same shares, the same value" : "-"}</td>
					</tr>
					<tr data-way="condition">
						<th scope="row">Buy only if the condition is met</th>
						<td>
							{result ? (
								<>
									<span className="tabular">
										<Figures>{formatShares(result.conditionalShares)}</Figures>
									</span>{" "}
									shares, worth{" "}
									<span className="tabular">
										<Figures>
											{formatUsd(roundCents(result.metValueCents))}
										</Figures>
									</span>
								</>
							) : (
								"-"
							)}
						</td>
						<td>
							{result ? (
								<>
									Your{" "}
									<span className="tabular">
										<Figures>
											{formatUsd(roundCents(result.notMetValueCents))}
										</Figures>
									</span>{" "}
									back
								</>
							) : (
								"-"
							)}
						</td>
					</tr>
					<tr data-way="call">
						<th scope="row">Buy call options</th>
						{result && optionReady && result.callValueCents !== undefined ? (
							<td colSpan={2}>
								Options on{" "}
								<span className="tabular">
									<Figures>{formatShares(result.callShares ?? 0)}</Figures>
								</span>{" "}
								shares, worth{" "}
								<span className="tabular">
									<Figures>
										{formatUsd(roundCents(result.callValueCents))}
									</Figures>
								</span>{" "}
								at expiry, whatever is reported
							</td>
						) : (
							<td colSpan={2} className={styles.muted}>
								Enter a call option&apos;s price and strike to compare.
							</td>
						)}
					</tr>
				</tbody>
			</table>
			{result ? (
				<p className={styles.muted}>
					The purchase only if met pays the pools&apos; fee of{" "}
					<span className="tabular">
						<Figures>{formatUsd(roundCents(result.feeCents))}</Figures>
					</span>
					. The value is taken at the price you entered; the real price after
					the announcement is unknown.
				</p>
			) : null}
		</section>
	);
}
