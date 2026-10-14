import Link from "next/link";
import styles from "./home.module.css";

/** Any address the interface does not serve: one plain sentence and the way back. */
export default function NotFound() {
	return (
		<main className={styles.page}>
			<section className={styles.lead} aria-labelledby="not-found-title">
				<h1 id="not-found-title" className={styles.headline}>
					There is nothing at this address.
				</h1>
				<p className={styles.explain}>
					The market may have a different name, or the link may be cut short.
				</p>
				<p>
					<Link href="/" className={styles.back}>
						See every open market
					</Link>
				</p>
			</section>
		</main>
	);
}
