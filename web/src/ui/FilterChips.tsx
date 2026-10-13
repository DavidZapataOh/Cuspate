"use client";

import { useState } from "react";
import styles from "./FilterChips.module.css";

/**
 * A set of filters, one active at a time, each a toggle button. Used to narrow the list of open
 * markets: all, this week, ending soon.
 */
export function FilterChips({
	options,
	selected,
	onSelect,
	label,
}: {
	options: string[];
	selected?: string;
	onSelect?: (option: string) => void;
	label: string;
}) {
	const [current, setCurrent] = useState(selected ?? options[0]);
	return (
		<fieldset data-primitive="filter-chips" className={styles.group}>
			<legend className={styles.legend}>{label}</legend>
			{options.map((option) => (
				<button
					key={option}
					type="button"
					aria-pressed={option === current}
					className={styles.chip}
					onClick={() => {
						setCurrent(option);
						onSelect?.(option);
					}}
				>
					{option}
				</button>
			))}
		</fieldset>
	);
}
