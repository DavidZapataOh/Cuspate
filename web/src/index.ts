/**
 * Formats a conditional leg price for display, in the quote asset's own units.
 *
 * @param price - The price in the quote asset's smallest unit.
 * @param decimals - The number of decimals the quote asset uses.
 * @returns The price as a decimal string, without a currency symbol.
 */
export function formatLegPrice(price: bigint, decimals: number): string {
	const scale = 10n ** BigInt(decimals);
	const whole = price / scale;
	const fraction = (price % scale).toString().padStart(decimals, "0");
	return `${whole}.${fraction}`;
}
