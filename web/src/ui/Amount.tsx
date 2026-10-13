import { formatUsd } from "../lib/format.ts";
import styles from "./Amount.module.css";
import { Figures } from "./Figures.tsx";

/**
 * An amount of dollars. At reading sizes it sets tabular figures, so it lines up with its neighbours;
 * at display sizes, lining figures. `size` is a step of the type scale; `tone` colours it as one of
 * the two outcomes when it belongs to one.
 */
export function Amount({
	cents,
	size = 1,
	tone,
}: {
	cents: bigint;
	size?: 0 | 1 | 2 | 3 | 4 | 5;
	tone?: "beat" | "dont";
}) {
	return (
		<span
			data-primitive="amount"
			data-size={size}
			data-tone={tone}
			className={styles.amount}
		>
			<Figures>{formatUsd(cents)}</Figures>
		</span>
	);
}
