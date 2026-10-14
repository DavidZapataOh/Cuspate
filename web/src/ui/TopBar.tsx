import Link from "next/link";
import { SignIn } from "../wallet/SignIn.tsx";
import { Mark } from "./Mark.tsx";
import styles from "./TopBar.module.css";
import { Wordmark } from "./Wordmark.tsx";

/**
 * The bar across every page: the mark and the name home, the places there are, and signing in.
 */
export function TopBar() {
	return (
		<header data-primitive="top-bar" className={styles.bar}>
			<Link href="/" className={styles.home} aria-label="Cuspate, all markets">
				<Mark size={28} />
				<Wordmark height={14} />
			</Link>
			<nav aria-label="Main" className={styles.nav}>
				<Link href="/" className={styles.link}>
					Markets
				</Link>
			</nav>
			<SignIn />
		</header>
	);
}
