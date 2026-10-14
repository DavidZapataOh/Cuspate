"use client";

import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { Button } from "../ui/Button.tsx";
import styles from "./SignIn.module.css";

/** The id of the sign-in panel, which any "Sign in" control opens. */
export const SIGN_IN_PANEL = "sign-in";

/** An address as people read it: its first six and last four characters. */
export function shortAddress(address: string): string {
	return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Signing in: the top bar's button and the panel it opens, which lists the wallets this browser
 * offers. Signing in with an email arrives with the email wallet; until then the panel says so.
 */
export function SignIn() {
	const { address } = useConnection();
	const connectors = useConnectors();
	const connect = useConnect();
	const disconnect = useDisconnect();
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
						<Button variant="secondary" onClick={() => disconnect.mutate()}>
							Sign out
						</Button>
					</>
				) : (
					<>
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
						) : (
							<p className={styles.note}>No wallet found in this browser.</p>
						)}
						{connect.error ? (
							<p className={styles.note} role="alert">
								The wallet did not connect. Try again.
							</p>
						) : null}
						<p className={styles.note}>Email sign-in opens soon.</p>
					</>
				)}
			</div>
		</>
	);
}
