const dollars = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** An amount of dollars from integer cents, with thousands separators and two decimals: "$12,410.50". */
export function formatUsd(cents: bigint): string {
	const negative = cents < 0n;
	const magnitude = negative ? -cents : cents;
	const whole = dollars.format(magnitude / 100n);
	const fraction = (magnitude % 100n).toString().padStart(2, "0");
	return `${negative ? "-" : ""}$${whole}.${fraction}`;
}

/**
 * A chance as a whole percentage. While a market is open no outcome is certain, so the ends read
 * "<1%" and ">99%" rather than rounding to 0% or 100%.
 */
export function formatChance(chance: number): string {
	const percent = Math.round(chance * 100);
	if (percent < 1) return "<1%";
	if (percent > 99) return ">99%";
	return `${percent}%`;
}

/** The time left until a moment, in days, hours and minutes: "8d 4h 12m", "12m", "under 1m", "now". */
export function formatCountdown(milliseconds: number): string {
	if (milliseconds <= 0) return "now";
	const minutes = Math.floor(milliseconds / 60_000);
	if (minutes === 0) return "under 1m";
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const rest = minutes % 60;
	if (days > 0) return `${days}d ${hours}h ${rest}m`;
	if (hours > 0) return `${hours}h ${rest}m`;
	return `${rest}m`;
}

/** A number of shares to at most four decimals, without trailing zeros: "0.41", "7.1235". */
export function formatShares(shares: number): string {
	return Number(shares.toFixed(4)).toString();
}
