"use client";

import { useId } from "react";
import { discGeometry } from "../lib/disc.ts";

/** The colour a mark is drawn in: one colour per use. */
export type MarkTone = "amber" | "cream" | "obsidian";

const fills: Record<MarkTone, string> = {
	amber: "var(--amber)",
	cream: "#F2E9DC",
	obsidian: "var(--bg)",
};

/**
 * The mark: a solid disc cut by a thin line of negative space, off centre 72/28 and tilted twelve
 * degrees. The cut is transparent, never a stroke drawn on top, and thickens below 24 px.
 */
export function Mark({
	size = 32,
	tone = "amber",
	title = "Cuspate",
}: {
	size?: number;
	tone?: MarkTone;
	title?: string;
}) {
	const g = discGeometry(size);
	const clip = useId();
	const left = g.cutX - g.gap / 2;
	const right = g.cutX + g.gap / 2;
	return (
		<svg
			data-primitive="mark"
			data-size={size}
			data-gap={g.gap.toFixed(2)}
			width={size}
			height={size}
			viewBox={`0 0 ${size} ${size}`}
			role="img"
		>
			<title>{title}</title>
			<defs>
				<clipPath id={`${clip}l`}>
					<rect x={-size} y={-size} width={left + size} height={size * 3} />
				</clipPath>
				<clipPath id={`${clip}r`}>
					<rect x={right} y={-size} width={size * 2} height={size * 3} />
				</clipPath>
			</defs>
			<g
				transform={`rotate(${g.angle} ${g.centre} ${g.centre})`}
				fill={fills[tone]}
			>
				<circle
					cx={g.centre}
					cy={g.centre}
					r={g.radius}
					clipPath={`url(#${clip}l)`}
				/>
				<circle
					cx={g.centre}
					cy={g.centre}
					r={g.radius}
					clipPath={`url(#${clip}r)`}
				/>
			</g>
		</svg>
	);
}
