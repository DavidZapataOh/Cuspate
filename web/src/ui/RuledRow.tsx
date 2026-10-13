import type { ReactNode } from "react";
import styles from "./RuledRow.module.css";

/**
 * One row of a ruled list, such as a condition of an event: what it is, its figure, and its
 * actions. The selected row is outlined, never filled with an outcome's colour.
 */
export function RuledRow({
	title,
	figure,
	actions,
	selected = false,
}: {
	title: ReactNode;
	figure?: ReactNode;
	actions?: ReactNode;
	selected?: boolean;
}) {
	return (
		<div
			data-primitive="ruled-row"
			data-selected={selected || undefined}
			className={styles.row}
		>
			<div className={styles.title}>{title}</div>
			{figure ? (
				<div className={`${styles.figure} tabular`}>{figure}</div>
			) : null}
			{actions ? <div className={styles.actions}>{actions}</div> : null}
		</div>
	);
}
