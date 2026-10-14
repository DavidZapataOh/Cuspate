"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useConnection } from "wagmi";
import { Button } from "../../src/ui/Button.tsx";
import { useEmailSession } from "../../src/wallet/EmailSession.tsx";
import { SIGN_IN_PANEL, shortAddress } from "../../src/wallet/SignIn.tsx";
import styles from "./portfolio.module.css";

/**
 * Whose positions are shown. The page reads the address in its link, so a portfolio can be shared
 * and reloaded; signing in puts the signed-in address there.
 */
export function AccountGate({ owner }: { owner?: string }) {
	const { address: connected } = useConnection();
	const { session } = useEmailSession();
	// An email session's wallet first, as the ticket does; otherwise the connected wallet.
	const address = session?.address ?? connected;
	const router = useRouter();
	useEffect(() => {
		if (address && !owner) router.replace(`/portfolio?address=${address}`);
	}, [address, owner, router]);
	if (owner)
		return (
			<p className={styles.who}>
				Positions held by <span className="tabular">{shortAddress(owner)}</span>
			</p>
		);
	return (
		<div className={styles.empty} data-state="signed-out">
			<p>Sign in to see your positions.</p>
			<Button variant="secondary" popoverTarget={SIGN_IN_PANEL}>
				Sign in
			</Button>
		</div>
	);
}
