"use client";

import { useId } from "react";
import { CUT_ANGLE_DEGREES, CUT_POSITION } from "../lib/disc.ts";

// Monoline geometric capitals on a 100-unit cap height, stroke 11. The A has no crossbar and is cut
// by the mark's own line: off centre 72/28 and tilted twelve degrees, as negative space.
const STROKE = 11;
const TRACK = 44;
const letters: { width: number; d: string }[] = [
	{ width: 84, d: "M76 22A40 40 0 1 0 76 78" },
	{ width: 76, d: "M6 6V58A32 32 0 0 0 70 58V6" },
	{
		width: 76,
		d: "M68 18C61 9 51 6 40 6 23 6 10 13 10 27 10 42 24 46 39 49 56 52 70 57 70 72 70 87 56 94 38 94 25 94 13 89 6 80",
	},
	{ width: 72, d: "M6 94V6H42A25 25 0 0 1 42 56H6" },
	{ width: 88, d: "M4 94 44 6 84 94" },
	{ width: 76, d: "M0 6H76M38 6V94" },
	{ width: 68, d: "M66 6H6V94H66M6 50H56" },
];
const A_INDEX = 4;

const offsets = letters.reduce<number[]>((acc, _, i) => {
	acc.push(
		i === 0 ? 0 : (acc[i - 1] ?? 0) + (letters[i - 1]?.width ?? 0) + TRACK,
	);
	return acc;
}, []);
const WIDTH = (offsets.at(-1) ?? 0) + (letters.at(-1)?.width ?? 0);
const PAD = STROKE;

/** The wordmark CUSPATE, in the mark's colour, at a given cap height in pixels. */
export function Wordmark({
	height = 20,
	tone = "var(--amber)",
	title = "Cuspate",
}: {
	height?: number;
	tone?: string;
	title?: string;
}) {
	const mask = useId();
	const viewWidth = WIDTH + PAD * 2;
	const viewHeight = 100 + PAD * 2;
	const aLeft = (offsets[A_INDEX] ?? 0) + PAD;
	const aWidth = letters[A_INDEX]?.width ?? 0;
	const cutX = aLeft + CUT_POSITION * aWidth;
	const gap = Math.max(5, (3 * viewHeight) / (height * 1.2));
	return (
		<svg
			data-primitive="wordmark"
			viewBox={`0 0 ${viewWidth} ${viewHeight}`}
			height={height * (viewHeight / 100)}
			width={height * (viewWidth / 100)}
			role="img"
		>
			<title>{title}</title>
			<defs>
				<mask
					id={mask}
					maskUnits="userSpaceOnUse"
					x="0"
					y="0"
					width={viewWidth}
					height={viewHeight}
				>
					<rect width={viewWidth} height={viewHeight} fill="white" />
					<rect
						x={cutX - gap / 2}
						y={-viewHeight}
						width={gap}
						height={viewHeight * 3}
						fill="black"
						transform={`rotate(${CUT_ANGLE_DEGREES} ${cutX} ${PAD + 50})`}
					/>
				</mask>
			</defs>
			<g
				fill="none"
				stroke={tone}
				strokeWidth={STROKE}
				strokeLinecap="butt"
				strokeLinejoin="miter"
			>
				{letters.map((letter, i) => (
					// The mask is in the wordmark's own space, so it goes on an untransformed group.
					<g key={letter.d} mask={i === A_INDEX ? `url(#${mask})` : undefined}>
						<path
							d={letter.d}
							transform={`translate(${(offsets[i] ?? 0) + PAD} ${PAD})`}
						/>
					</g>
				))}
			</g>
		</svg>
	);
}
