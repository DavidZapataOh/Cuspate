import { formatChance } from "../lib/format.ts";
import styles from "./ChanceBar.module.css";

/**
 * The chance that a condition is met, as one bar split in the two outcomes' colours: cream for
 * "if they beat", stone for the rest, with the figure in words beside it.
 */
export function ChanceBar({
	chance,
	showLabel = true,
}: {
	chance: number;
	showLabel?: boolean;
}) {
	const bounded = Math.min(Math.max(chance, 0), 1);
	const text = `${formatChance(bounded)} likely`;
	return (
		<div data-primitive="chance-bar" className={styles.wrap}>
			<div className={styles.bar} role="img" aria-label={text}>
				<span className={styles.beat} style={{ width: `${bounded * 100}%` }} />
				<span className={styles.dont} />
			</div>
			{showLabel ? (
				<span className={`${styles.label} tabular`} aria-hidden="true">
					{text}
				</span>
			) : null}
		</div>
	);
}
