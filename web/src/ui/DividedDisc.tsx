"use client";

import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { discGeometry } from "../lib/disc.ts";
import styles from "./DividedDisc.module.css";

/**
 * Where a position stands: `whole` before it exists or after it is undone, `split` while it is
 * held, and `resolved-yes` or `resolved-no` once the result is in.
 */
export type DiscState = "whole" | "split" | "resolved-yes" | "resolved-no";

/**
 * The divided disc, the interface's one authored motion. Splitting slides the small part six per
 * cent along the cut (320 ms, ease-out); undoing slides it back and settles by one pixel; resolving
 * fades the losing part in 600 ms. The large part is the "if they beat" world, in cream; the small
 * part the "if they don't" world, in stone. With reduced motion nothing moves: opacity alone.
 */
export function DividedDisc({
	state,
	size = 96,
	label,
}: {
	state: DiscState;
	size?: number;
	label?: string;
}) {
	const g = discGeometry(size);
	const id = useId();
	const previous = useRef(state);
	const [undoing, setUndoing] = useState(false);

	useEffect(() => {
		setUndoing(previous.current === "split" && state === "whole");
		previous.current = state;
	}, [state]);

	const left = g.cutX - g.gap / 2;
	const right = g.cutX + g.gap / 2;
	return (
		<svg
			data-primitive="divided-disc"
			data-state={state}
			className={styles.disc}
			data-undoing={undoing || undefined}
			width={size}
			height={size}
			viewBox={`${-g.slide} ${-g.slide} ${size + 2 * g.slide} ${size + 2 * g.slide}`}
			style={{ "--slide": `${-g.slide}px` } as CSSProperties}
			role="img"
			aria-label={label ?? describe(state)}
		>
			<defs>
				<clipPath id={`${id}l`}>
					<rect x={-size} y={-size} width={left + size} height={size * 3} />
				</clipPath>
				<clipPath id={`${id}r`}>
					<rect x={right} y={-size} width={size * 2} height={size * 3} />
				</clipPath>
			</defs>
			<g transform={`rotate(${g.angle} ${g.centre} ${g.centre})`}>
				<g data-part="large" className={styles.large}>
					<circle
						cx={g.centre}
						cy={g.centre}
						r={g.radius}
						clipPath={`url(#${id}l)`}
					/>
				</g>
				<g data-part="small" className={styles.small}>
					<circle
						cx={g.centre}
						cy={g.centre}
						r={g.radius}
						clipPath={`url(#${id}r)`}
					/>
				</g>
			</g>
		</svg>
	);
}

function describe(state: DiscState): string {
	switch (state) {
		case "whole":
			return "No position";
		case "split":
			return "Position held, both outcomes open";
		case "resolved-yes":
			return "Resolved: they beat";
		case "resolved-no":
			return "Resolved: they did not beat";
	}
}
