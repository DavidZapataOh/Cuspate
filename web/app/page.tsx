import styles from "./page.module.css";

// A holding page until the markets screen exists. It uses no mark: the vectors await approval.
export default function Home() {
	return (
		<main className={styles.main}>
			<h1 className={styles.name}>Cuspate</h1>
			<p className={styles.line}>Buy it only if.</p>
		</main>
	);
}
