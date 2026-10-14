import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

/** How loud a button is: one amber primary per view, quiet secondaries, and text links. */
export type ButtonVariant = "primary" | "secondary" | "link";

/**
 * A button that names its action. `loading` keeps the label, disables the button and says it is
 * busy, so a second press cannot send twice.
 */
export function Button({
	variant = "primary",
	loading = false,
	disabled,
	children,
	type = "button",
	className,
	...rest
}: {
	variant?: ButtonVariant;
	loading?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
	const state = loading ? "loading" : disabled ? "disabled" : "enabled";
	return (
		<button
			type={type}
			data-primitive="button"
			data-variant={variant}
			data-state={state}
			className={className ? `${styles.button} ${className}` : styles.button}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			{...rest}
		>
			{loading ? (
				<svg className={styles.spinner} viewBox="0 0 16 16" aria-hidden="true">
					<circle cx="8" cy="8" r="6" />
				</svg>
			) : null}
			{children}
		</button>
	);
}
