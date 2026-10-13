import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import styles from "./Notice.module.css";

/**
 * A message about what just happened or what to know. An error names the problem and the way
 * back, with an icon and words, never colour alone; it is announced as it appears.
 */
export function Notice({
	tone = "info",
	children,
}: {
	tone?: "info" | "error";
	children: ReactNode;
}) {
	return (
		<div
			data-primitive="notice"
			data-tone={tone}
			role={tone === "error" ? "alert" : "status"}
			className={styles.notice}
		>
			<Icon
				name={tone === "error" ? "alert" : "info"}
				size={20}
				className={styles.icon}
			/>
			<div className={styles.body}>{children}</div>
		</div>
	);
}
