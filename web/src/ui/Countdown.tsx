"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "../lib/format.ts";

/**
 * The time left until a moment, in days, hours and minutes, refreshed every twenty seconds. The
 * moment itself is the element's machine-readable date. `prefix` names what happens then. The time
 * left is written only in the browser, from its own clock, so the server's clock never has to agree
 * with it.
 */
export function Countdown({
	until,
	prefix,
}: {
	until: string;
	prefix?: string;
}) {
	const target = Date.parse(until);
	const [now, setNow] = useState<number | undefined>(undefined);
	useEffect(() => {
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 20_000);
		return () => clearInterval(timer);
	}, []);
	return (
		<time data-primitive="countdown" dateTime={until} className="tabular">
			{now === undefined
				? null
				: `${prefix ? `${prefix} ` : ""}${formatCountdown(target - now)}`}
		</time>
	);
}
