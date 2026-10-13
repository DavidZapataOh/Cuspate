import styles from "./OutcomeLabel.module.css";

/** The two worlds of a condition. */
export type Outcome = "beat" | "dont";

const words: Record<Outcome, string> = {
	beat: "If they beat",
	dont: "If they don't",
};

/**
 * The name of one outcome, in its colour: cream for "if they beat", stone for "if they don't".
 * The words always say which it is; colour never carries the difference alone.
 */
export function OutcomeLabel({
	outcome,
	children,
}: {
	outcome: Outcome;
	children?: string;
}) {
	return (
		<span
			data-primitive="outcome-label"
			data-outcome={outcome}
			className={styles.label}
		>
			{children ?? words[outcome]}
		</span>
	);
}
