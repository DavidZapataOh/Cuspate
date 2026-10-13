import type { SVGProps } from "react";

/** The icons the interface draws, all on one 24 px grid with one stroke weight. */
export type IconName =
	| "clock"
	| "alert"
	| "info"
	| "search"
	| "check"
	| "chevron-right"
	| "lock";

const paths: Record<IconName, string> = {
	clock:
		"M12 3.75a8.25 8.25 0 1 0 0 16.5 8.25 8.25 0 0 0 0-16.5ZM12 7.5V12l3 2",
	alert: "M12 4 21 19.5H3L12 4ZM12 10v4.25M12 16.75v.5",
	info: "M12 3.75a8.25 8.25 0 1 0 0 16.5 8.25 8.25 0 0 0 0-16.5ZM12 11v5M12 7.75v.5",
	search: "M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM15 15l4.5 4.5",
	check: "M5 12.5 9.5 17 19 7.5",
	"chevron-right": "M9.5 6 15.5 12 9.5 18",
	lock: "M7 10.5V8a5 5 0 0 1 10 0v2.5M5.5 10.5h13v9h-13z",
};

/** One icon, drawn in the current text colour. Icons are decorative: the words beside them carry the meaning. */
export function Icon({
	name,
	size = 20,
	...rest
}: {
	name: IconName;
	size?: number;
} & SVGProps<SVGSVGElement>) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...rest}
		>
			<path d={paths[name]} />
		</svg>
	);
}
