import type { Metadata } from "next";
import { FundView } from "./FundView.tsx";
import styles from "./fund.module.css";

export const metadata: Metadata = { title: "Add dollars - Cuspate" };

export default function FundPage() {
	return (
		<main className={styles.page}>
			<header className={styles.lead}>
				<h1 className={styles.headline}>Add dollars</h1>
				<p className={styles.explain}>
					Send USDC or USDT from another chain. It arrives as USDC on Monad, at
					your address, usually in under a minute.
				</p>
			</header>
			<FundView />
		</main>
	);
}
