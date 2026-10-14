import type { ChancePoint } from "../data/model.ts";
import { formatChance } from "../lib/format.ts";
import styles from "./LineChart.module.css";

const WIDTH = 640;
const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 28, left: 44 };
const GRID = [0, 0.25, 0.5, 0.75, 1];

const day = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/New_York",
	month: "short",
	day: "numeric",
});

/**
 * A condition's chance over time: one cream line on a quiet grid, the last point marked. The same
 * points are in a table for anyone who does not read the picture.
 */
export function LineChart({
	points,
	label,
}: {
	points: ChancePoint[];
	label: string;
}) {
	const first = points[0]?.at ?? 0;
	const last = points.at(-1)?.at ?? 1;
	const span = Math.max(last - first, 1);
	const x = (at: number) =>
		PAD.left + ((at - first) / span) * (WIDTH - PAD.left - PAD.right);
	const y = (chance: number) =>
		PAD.top + (1 - chance) * (HEIGHT - PAD.top - PAD.bottom);
	const path = points
		.map(
			(p, i) =>
				`${i === 0 ? "M" : "L"}${x(p.at).toFixed(1)},${y(p.chance).toFixed(1)}`,
		)
		.join("");
	const end = points.at(-1);
	const ticks = [0, 0.5, 1].map((f) => first + f * span);
	const rows = points.filter((_, i) => i % 24 === 0 || i === points.length - 1);
	return (
		<figure data-primitive="line-chart" className={styles.chart}>
			<svg
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				className={styles.svg}
				role="img"
				aria-label={`${label}: ${end ? formatChance(end.chance) : "no data"} now`}
			>
				{GRID.map((g) => (
					<g key={g}>
						<line
							x1={PAD.left}
							x2={WIDTH - PAD.right}
							y1={y(g)}
							y2={y(g)}
							className={styles.grid}
						/>
						<text
							x={PAD.left - 10}
							y={y(g) + 4}
							className={styles.axis}
							textAnchor="end"
						>
							{`${g * 100}%`}
						</text>
					</g>
				))}
				{ticks.map((t) => (
					<text
						key={t}
						x={x(t)}
						y={HEIGHT - 6}
						className={styles.axis}
						textAnchor={t === first ? "start" : t === last ? "end" : "middle"}
					>
						{day.format(new Date(t))}
					</text>
				))}
				<path d={path} className={styles.line} />
				{end ? (
					<circle
						cx={x(end.at)}
						cy={y(end.chance)}
						r={4}
						className={styles.end}
					/>
				) : null}
			</svg>
			<div className={styles.table}>
				<table>
					<caption>{label}</caption>
					<thead>
						<tr>
							<th scope="col">Day</th>
							<th scope="col">Chance</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((p) => (
							<tr key={p.at}>
								<td>{day.format(new Date(p.at))}</td>
								<td>{formatChance(p.chance)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</figure>
	);
}
