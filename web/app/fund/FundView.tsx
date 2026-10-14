"use client";

import { useEffect, useId, useState } from "react";
import { useFundingAddress } from "../../src/funding/account.ts";
import {
	isFinal,
	MONAD_USDC,
	PHASE_TEXT,
	type Progress,
	type Quote,
	SOURCES,
	sourceById,
	toBaseUnits,
} from "../../src/funding/intents.ts";
import { AmountInput } from "../../src/ui/AmountInput.tsx";
import { Button } from "../../src/ui/Button.tsx";
import { Card } from "../../src/ui/Card.tsx";
import { Notice } from "../../src/ui/Notice.tsx";
import { SIGN_IN_PANEL, shortAddress } from "../../src/wallet/SignIn.tsx";
import styles from "./fund.module.css";

const POLL_MS = 5000;

function formatUnits(units: string, decimals: number): string {
	const value = Number(units) / 10 ** decimals;
	return value.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function money(formatted: string): string {
	return Number(formatted).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

export function FundView() {
	const address = useFundingAddress();
	const selectId = useId();
	const [sourceId, setSourceId] = useState(SOURCES[0]?.id ?? "");
	const [amount, setAmount] = useState("");
	const [fieldError, setFieldError] = useState<string>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [quote, setQuote] = useState<Quote>();
	const [progress, setProgress] = useState<Progress>();
	const [copied, setCopied] = useState(false);
	const source = sourceById(sourceId);

	useEffect(() => {
		if (!quote) return;
		let stopped = false;
		const check = async () => {
			try {
				const response = await fetch(
					`/api/funding/status?depositAddress=${quote.depositAddress}`,
					{ cache: "no-store" },
				);
				if (!response.ok || stopped) return;
				const next = (await response.json()) as Progress;
				if (stopped) return;
				setProgress(next);
				if (isFinal(next.phase)) {
					stopped = true;
					clearInterval(timer);
				}
			} catch {
				// A missed check is retried on the next tick.
			}
		};
		const timer = setInterval(check, POLL_MS);
		void check();
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [quote]);

	async function getQuote() {
		if (!source || !address) return;
		const parsed = toBaseUnits(amount, source.decimals);
		if ("error" in parsed) {
			setFieldError(parsed.error);
			return;
		}
		setFieldError(undefined);
		setError(undefined);
		setLoading(true);
		try {
			const response = await fetch("/api/funding/quote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: source.id, amount, address }),
			});
			const body = (await response.json().catch(() => ({}))) as Quote & {
				error?: string;
			};
			if (!response.ok) {
				setError(body.error ?? "No quote right now. Try again in a minute.");
				return;
			}
			setProgress(undefined);
			setCopied(false);
			setQuote(body);
		} catch {
			setError("Could not reach the server. Check your connection and retry.");
		} finally {
			setLoading(false);
		}
	}

	function startOver() {
		setQuote(undefined);
		setProgress(undefined);
		setError(undefined);
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	}

	return (
		<div className={styles.layout}>
			<Card as="section" className={styles.panel} aria-labelledby="fund-form">
				<h2 id="fund-form" className={styles.title}>
					{quote ? "Send to this address" : "Where from"}
				</h2>
				{!address ? (
					<div className={styles.signin}>
						<p>
							Sign in first. Your dollars arrive at your own address, and any
							refund goes back to it.
						</p>
						<Button popoverTarget={SIGN_IN_PANEL}>Sign in</Button>
					</div>
				) : quote && source ? (
					<div className={styles.quote}>
						<p className={styles.instruction}>
							Send exactly{" "}
							<strong className="tabular">
								{money(quote.amountIn)} {source.token}
							</strong>{" "}
							on <strong>{source.chain}</strong> to:
						</p>
						<div className={styles.deposit}>
							<code className={styles.code}>{quote.depositAddress}</code>
							<Button
								variant="secondary"
								onClick={() => copy(quote.depositAddress)}
							>
								{copied ? "Copied" : "Copy"}
							</Button>
						</div>
						<dl className={styles.rows}>
							<div>
								<dt>You send</dt>
								<dd className="tabular">
									{money(quote.amountIn)} {source.token} on {source.chain}
								</dd>
							</div>
							<div>
								<dt>You receive</dt>
								<dd className="tabular">
									about {money(quote.amountOut)} USDC on Monad
								</dd>
							</div>
							<div>
								<dt>At least</dt>
								<dd className="tabular">
									{formatUnits(quote.minAmountOut, MONAD_USDC.decimals)} USDC,
									or a refund
								</dd>
							</div>
							<div>
								<dt>Arrives in</dt>
								<dd className="tabular">about {quote.seconds} seconds</dd>
							</div>
							<div>
								<dt>To</dt>
								<dd className="tabular">{shortAddress(address)} on Monad</dd>
							</div>
							<div>
								<dt>Address open until</dt>
								<dd className="tabular">
									{new Date(quote.deadline).toLocaleString("en-US", {
										dateStyle: "medium",
										timeStyle: "short",
									})}
								</dd>
							</div>
						</dl>
						<p className={styles.status} role="status" aria-live="polite">
							{progress ? PHASE_TEXT[progress.phase] : "Checking..."}
							{progress?.phase === "arrived" && progress.received
								? ` ${money(progress.received)} USDC received.`
								: null}
						</p>
						<Button variant="link" onClick={startOver}>
							Start over
						</Button>
					</div>
				) : (
					<form
						className={styles.form}
						onSubmit={(event) => {
							event.preventDefault();
							void getQuote();
						}}
					>
						<div className={styles.field}>
							<label htmlFor={selectId} className={styles.label}>
								Send from
							</label>
							<select
								id={selectId}
								className={styles.select}
								value={sourceId}
								onChange={(event) => setSourceId(event.target.value)}
							>
								{SOURCES.map((s) => (
									<option key={s.id} value={s.id}>
										{s.token} on {s.chain}
									</option>
								))}
							</select>
						</div>
						<AmountInput
							label="Amount"
							unit={source?.token ?? "USD"}
							error={fieldError}
							onChange={(value) => {
								setAmount(value);
								setFieldError(undefined);
							}}
						/>
						{error ? (
							<Notice tone="error">
								<p>{error}</p>
							</Notice>
						) : null}
						<Button type="submit" loading={loading}>
							Get deposit address
						</Button>
					</form>
				)}
			</Card>
			<aside className={styles.aside}>
				<Notice>
					<p>
						Deposits arrive as real USDC on Monad mainnet. The markets on this
						site run on the Monad test network with test dollars, so a deposit
						does not add to your test balance.
					</p>
				</Notice>
				<p className={styles.small}>
					Routed by NEAR Intents. If the price moves past the quote, or the
					deposit is short, the dollars go back to the address you sent from.
				</p>
			</aside>
		</div>
	);
}
