"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "../lib/format.ts";

/**
 * The time left until a moment, in days, hours and minutes, refreshed every twenty seconds. The
 * moment itself is the element's machine-readable date. `prefix` names what happens then.
 */
export function Countdown({
	until,
	prefix,
}: {
	until: string;
	prefix?: string;
}) {
	const target = Date.parse(until);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 20_000);
		return () => clearInterval(timer);
	}, []);
	return (
		<time
			data-primitive="countdown"
			dateTime={until}
			className="tabular"
			suppressHydrationWarning
		>
			{prefix ? `${prefix} ` : null}
			{formatCountdown(target - now)}
		</time>
	);
}
