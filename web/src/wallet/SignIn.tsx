"use client";

import { type FormEvent, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { Button } from "../ui/Button.tsx";
import { useEmailSession } from "./EmailSession.tsx";
import styles from "./SignIn.module.css";

/** The id of the sign-in panel, which any "Sign in" control opens. */
export const SIGN_IN_PANEL = "sign-in";

/** An address as people read it: its first six and last four characters. */
export function shortAddress(address: string): string {
	return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Signing in with an email: the address, then the code sent to it. */
function EmailForm() {
	const email = useEmailSession();
	const [address, setAddress] = useState("");
	const [code, setCode] = useState("");
	const [sent, setSent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			if (sent) await email.signIn(address.trim(), code.trim());
			else {
				await email.sendCode(address.trim());
				setSent(true);
			}
		} catch (failure) {
			setError(
				failure instanceof Error ? failure.message : "That did not work.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className={styles.form} onSubmit={submit}>
			<label className={styles.field}>
				<span>Email</span>
				<input
					className={styles.input}
					type="email"
					autoComplete="email"
					required
					value={address}
					readOnly={sent}
					onChange={(e) => setAddress(e.target.value)}
				/>
			</label>
			{sent ? (
				<label className={styles.field}>
					<span>Code sent to your email</span>
					<input
						className={styles.input}
						inputMode="numeric"
						autoComplete="one-time-code"
						required
						value={code}
						onChange={(e) => setCode(e.target.value)}
					/>
				</label>
			) : null}
			<Button type="submit" loading={busy}>
				{sent ? "Sign in" : "Email me a code"}
			</Button>
			{error ? (
				<p className={styles.note} role="alert">
					{error}
				</p>
			) : null}
			<p className={styles.note}>
				A wallet is made for you. Cuspate pays the network fees.
			</p>
		</form>
	);
}

/**
 * Signing in: the top bar's button and the panel it opens, with an email, or with a wallet this
 * browser offers.
 */
export function SignIn() {
	const { address: connected } = useConnection();
	const email = useEmailSession();
	const connectors = useConnectors();
	const connect = useConnect();
	const disconnect = useDisconnect();
	const address = email.session?.address ?? connected;
	return (
		<>
			<Button
				variant="secondary"
				popoverTarget={SIGN_IN_PANEL}
				className={styles.trigger}
			>
				{address ? shortAddress(address) : "Sign in"}
			</Button>
			<div
				id={SIGN_IN_PANEL}
				popover="auto"
				role="dialog"
				className={styles.panel}
				aria-labelledby="sign-in-title"
			>
				<h2 id="sign-in-title" className={styles.title}>
					{address ? "Signed in" : "Sign in"}
				</h2>
				{address ? (
					<>
						<p className={styles.who}>{shortAddress(address)}</p>
						<Button
							variant="secondary"
							onClick={() =>
								email.session ? email.signOut() : disconnect.mutate()
							}
						>
							Sign out
						</Button>
					</>
				) : (
					<>
						{email.enabled ? <EmailForm /> : null}
						{connectors.length > 0 ? (
							<ul className={styles.wallets}>
								{connectors.map((connector) => (
									<li key={connector.uid}>
										<Button
											variant="secondary"
											loading={
												connect.isPending &&
												connect.variables?.connector === connector
											}
											onClick={() => connect.mutate({ connector })}
										>
											{connector.name}
										</Button>
									</li>
								))}
							</ul>
						) : email.enabled ? null : (
							<p className={styles.note}>No wallet found in this browser.</p>
						)}
						{connect.error ? (
							<p className={styles.note} role="alert">
								The wallet did not connect. Try again.
							</p>
						) : null}
					</>
				)}
			</div>
		</>
	);
}
