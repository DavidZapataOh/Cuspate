const easternParts = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/New_York",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	hour12: true,
});

/**
 * An announcement in New York time, where the companies report: "Oct 21, 4:00 pm ET". Built from
 * parts so server and browser print the same characters whatever their locale data.
 */
export function announcementEt(iso: string): string {
	const part = (type: string) =>
		easternParts.formatToParts(new Date(iso)).find((p) => p.type === type)
			?.value ?? "";
	return `${part("month")} ${part("day")}, ${part("hour")}:${part("minute")} ${part("dayPeriod").toLowerCase()} ET`;
}

/** The same moment in UTC, exactly: "2026-10-21 20:00 UTC". */
export function announcementUtc(iso: string): string {
	return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A length of time in the largest whole unit: "10 minutes", "2 hours", "1 day". */
export function duration(seconds: number): string {
	const units: [number, string][] = [
		[86_400, "day"],
		[3_600, "hour"],
		[60, "minute"],
	];
	for (const [size, name] of units) {
		if (seconds >= size && seconds % size === 0) {
			const n = seconds / size;
			return `${n} ${name}${n === 1 ? "" : "s"}`;
		}
	}
	return `${seconds} seconds`;
}
