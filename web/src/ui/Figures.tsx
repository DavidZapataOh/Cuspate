import styles from "./Figures.module.css";

/**
 * A run of figures whose digits are tabular, so columns line up on the digits, while the
 * separators ('.' and ',') keep their natural width: the face's tabular separators are as wide as a
 * digit, which pulls an amount apart.
 */
export function Figures({ children }: { children: string }) {
	return (
		<>
			{children.split(/([.,])/).map((part, index) =>
				part === "." || part === "," ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one string never reorder
					<span key={index} className={styles.separator}>
						{part}
					</span>
				) : (
					part
				),
			)}
		</>
	);
}
