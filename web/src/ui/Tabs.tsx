"use client";

import { type KeyboardEvent, useRef, useState } from "react";
import styles from "./Tabs.module.css";

/** One tab: what it is called and, beside it, a short figure such as a chance. */
export type Tab = { id: string; label: string; detail?: string };

/**
 * A row of tabs choosing one of several views, such as the conditions of an event. Arrow keys move
 * between tabs, as the platform's own tabs do.
 */
export function Tabs({
	tabs,
	selected,
	onSelect,
	label,
}: {
	tabs: Tab[];
	selected?: string;
	onSelect?: (id: string) => void;
	label: string;
}) {
	const [current, setCurrent] = useState(selected ?? tabs[0]?.id);
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const choose = (id: string) => {
		setCurrent(id);
		onSelect?.(id);
	};
	const onKey = (event: KeyboardEvent, index: number) => {
		const step =
			event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		const next = (index + step + tabs.length) % tabs.length;
		const tab = tabs[next];
		if (!tab) return;
		choose(tab.id);
		refs.current[next]?.focus();
	};
	return (
		<div
			data-primitive="tabs"
			role="tablist"
			aria-label={label}
			className={styles.list}
		>
			{tabs.map((tab, index) => {
				const active = tab.id === current;
				return (
					<button
						key={tab.id}
						ref={(el) => {
							refs.current[index] = el;
						}}
						type="button"
						role="tab"
						aria-selected={active}
						tabIndex={active ? 0 : -1}
						className={styles.tab}
						onClick={() => choose(tab.id)}
						onKeyDown={(event) => onKey(event, index)}
					>
						<span className={styles.label}>{tab.label}</span>
						{tab.detail ? (
							<span className={`${styles.detail} tabular`}>{tab.detail}</span>
						) : null}
					</button>
				);
			})}
		</div>
	);
}
