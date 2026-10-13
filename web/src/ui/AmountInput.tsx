"use client";

import { useId } from "react";
import styles from "./AmountInput.module.css";

/**
 * An amount of dollars to put in: a dollar sign before it, the unit after it, decimal keyboard on a
 * phone. An `error` is said in words under the field and announced with it.
 */
export function AmountInput({
	label = "Amount",
	defaultValue,
	error,
	disabled = false,
	unit = "USD",
}: {
	label?: string;
	defaultValue?: string;
	error?: string;
	disabled?: boolean;
	unit?: string;
}) {
	const id = useId();
	const hint = `${id}-error`;
	return (
		<div
			data-primitive="amount-input"
			data-invalid={error ? true : undefined}
			className={styles.field}
		>
			<label htmlFor={id} className={styles.label}>
				{label}
			</label>
			<div className={styles.box}>
				<span className={styles.sign} aria-hidden="true">
					$
				</span>
				<input
					id={id}
					className={`${styles.input} tabular`}
					type="text"
					inputMode="decimal"
					autoComplete="off"
					defaultValue={defaultValue}
					placeholder="0.00"
					disabled={disabled}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? hint : undefined}
				/>
				<span className={styles.unit}>{unit}</span>
			</div>
			{error ? (
				<p id={hint} className={styles.error}>
					{error}
				</p>
			) : null}
		</div>
	);
}
