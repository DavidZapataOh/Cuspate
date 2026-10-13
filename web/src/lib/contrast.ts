/** The relative luminance of an opaque `#RRGGBB` colour, as WCAG 2 defines it. */
export function relativeLuminance(hex: string): number {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!match) throw new Error(`not an opaque hex colour: ${hex}`);
	const [r, g, b] = match.slice(1).map((pair) => {
		const channel = Number.parseInt(pair, 16) / 255;
		return channel <= 0.04045
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2 contrast ratio between two opaque colours, from 1 to 21, in either order. */
export function contrastRatio(a: string, b: string): number {
	const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort(
		(x, y) => y - x,
	) as [number, number];
	return (light + 0.05) / (dark + 0.05);
}
