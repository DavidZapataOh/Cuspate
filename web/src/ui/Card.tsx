import type { HTMLAttributes } from "react";
import styles from "./Card.module.css";

/**
 * A surface that holds one thing: a market, a ticket, a panel. `raised` is the second surface, for
 * what sits on top of another card's level, never a card inside a card.
 */
export function Card({
	raised = false,
	as: Tag = "div",
	className,
	...rest
}: {
	raised?: boolean;
	as?: "div" | "section" | "article" | "aside";
} & HTMLAttributes<HTMLElement>) {
	return (
		<Tag
			data-primitive="card"
			data-raised={raised || undefined}
			className={className ? `${styles.card} ${className}` : styles.card}
			{...rest}
		/>
	);
}
