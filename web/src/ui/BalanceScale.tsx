import type { CSSProperties } from "react";
import { beamAngle } from "../lib/balance.ts";
import { formatUsd } from "../lib/format.ts";
import { Amount } from "./Amount.tsx";
import styles from "./BalanceScale.module.css";
import { Figures } from "./Figures.tsx";
import { OutcomeLabel } from "./OutcomeLabel.tsx";

/** One pan of the scale: what the outcome gives and what it costs today. */
export type Pan = {
	/** What a holder ends with in this world, in words: "0.41 TSLA shares", "$500.00 back". */
	gives: string;
	/** Today's price of this outcome, in integer cents. */
	price: bigint;
};

const PIVOT_X = 500;
const PIVOT_Y = 44;
const HALF = 360;
const HANG = 64;

/**
 * The two worlds of one condition as the two pans of a balance. The beam tilts by a small angle
 * toward the likelier world, slowly, and the fulcrum states that the two prices add up to the real
 * price: the proof there is no trick. `compact` is the version that tops a ticket: the beam alone
 * above two pans that stand side by side.
 */
export function BalanceScale({
	chance,
	beat,
	dont,
	compact = false,
}: {
	chance: number;
	beat: Pan;
	dont: Pan;
	compact?: boolean;
}) {
	const angle = beamAngle(chance);
	const drop = HALF * Math.sin((angle * Math.PI) / 180);
	// The beat pan hangs on the left: a negative angle lowers it.
	const leftDrop = -drop;
	const rightDrop = drop;
	const total = beat.price + dont.price;
	return (
		<figure
			data-primitive="balance-scale"
			data-compact={compact || undefined}
			className={styles.scale}
			style={
				{
					"--left-drop": leftDrop.toFixed(2),
					"--right-drop": rightDrop.toFixed(2),
				} as CSSProperties
			}
		>
			<svg
				className={styles.frame}
				viewBox={compact ? "0 0 1000 120" : "0 0 1000 300"}
				aria-hidden="true"
				preserveAspectRatio="xMidYMin meet"
			>
				<g className={styles.ink}>
					{compact ? null : (
						<>
							<line x1={PIVOT_X} y1={PIVOT_Y} x2={PIVOT_X} y2={292} />
							<line x1={PIVOT_X - 70} y1={292} x2={PIVOT_X + 70} y2={292} />
						</>
					)}
					<g
						data-part="beam"
						data-angle={angle}
						className={styles.beam}
						style={{ transform: `rotate(${angle}deg)` }}
					>
						<line
							x1={PIVOT_X - HALF}
							y1={PIVOT_Y}
							x2={PIVOT_X + HALF}
							y2={PIVOT_Y}
						/>
					</g>
					<circle cx={PIVOT_X} cy={PIVOT_Y} r={7} className={styles.pivot} />
					<g className={styles.left}>
						<circle
							cx={PIVOT_X - HALF}
							cy={PIVOT_Y}
							r={4}
							className={styles.pivot}
						/>
						<line
							x1={PIVOT_X - HALF}
							y1={PIVOT_Y}
							x2={PIVOT_X - HALF - 70}
							y2={PIVOT_Y + HANG}
						/>
						<line
							x1={PIVOT_X - HALF}
							y1={PIVOT_Y}
							x2={PIVOT_X - HALF + 70}
							y2={PIVOT_Y + HANG}
						/>
					</g>
					<g className={styles.right}>
						<circle
							cx={PIVOT_X + HALF}
							cy={PIVOT_Y}
							r={4}
							className={styles.pivot}
						/>
						<line
							x1={PIVOT_X + HALF}
							y1={PIVOT_Y}
							x2={PIVOT_X + HALF - 70}
							y2={PIVOT_Y + HANG}
						/>
						<line
							x1={PIVOT_X + HALF}
							y1={PIVOT_Y}
							x2={PIVOT_X + HALF + 70}
							y2={PIVOT_Y + HANG}
						/>
					</g>
				</g>
			</svg>
			<div className={`${styles.pan} ${styles.panLeft}`}>
				<OutcomeLabel outcome="beat" />
				<span className={styles.gives}>{beat.gives}</span>
				<Amount cents={beat.price} size={compact ? 3 : 4} tone="beat" />
			</div>
			<div className={`${styles.pan} ${styles.panRight}`}>
				<OutcomeLabel outcome="dont" />
				<span className={styles.gives}>{dont.gives}</span>
				<Amount cents={dont.price} size={compact ? 3 : 4} tone="dont" />
			</div>
			<figcaption className={styles.sum}>
				<span>
					<Figures>{`${formatUsd(beat.price)} + ${formatUsd(dont.price)}`}</Figures>
				</span>
				<span className={styles.total}>
					<Figures>{`= ${formatUsd(total)}`}</Figures>
				</span>
				<span className={styles.note}>the real price</span>
			</figcaption>
		</figure>
	);
}
