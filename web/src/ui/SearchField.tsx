"use client";

import { useId } from "react";
import { Icon } from "./Icon.tsx";
import styles from "./SearchField.module.css";

/** A search over a list, such as the open markets: a name, a field, and what it narrows as you type. */
export function SearchField({
	label,
	placeholder,
	value,
	onChange,
}: {
	label: string;
	placeholder?: string;
	value?: string;
	onChange?: (value: string) => void;
}) {
	const id = useId();
	return (
		<div data-primitive="search-field" className={styles.field}>
			<label htmlFor={id} className={styles.label}>
				{label}
			</label>
			<div className={styles.box}>
				<Icon name="search" size={18} className={styles.icon} />
				<input
					id={id}
					type="search"
					className={styles.input}
					placeholder={placeholder}
					autoComplete="off"
					spellCheck={false}
					value={value}
					onChange={
						onChange ? (event) => onChange(event.target.value) : undefined
					}
				/>
			</div>
		</div>
	);
}
