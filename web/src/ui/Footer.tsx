import styles from "./Footer.module.css";
import { Wordmark } from "./Wordmark.tsx";

const REPOSITORY = "https://github.com/DavidZapataOh/Cuspate";

/** The foot of every page: the name, the code, the deployed contracts and how to reach us. */
export function Footer() {
	return (
		<footer data-primitive="footer" className={styles.footer}>
			<Wordmark height={12} title="Cuspate" />
			<nav aria-label="Project" className={styles.links}>
				<a href={REPOSITORY}>GitHub</a>
				<a href={`${REPOSITORY}/blob/main/contracts/deployments/10143.json`}>
					Contracts
				</a>
				<a href="mailto:ops@cuspate.xyz">ops@cuspate.xyz</a>
			</nav>
		</footer>
	);
}
