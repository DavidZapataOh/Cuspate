/** Where the cut crosses the disc: the large part spans 72% of the diameter. Never 50/50. */
export const CUT_POSITION = 0.72;

/** The cut's tilt from the vertical, in degrees. */
export const CUT_ANGLE_DEGREES = 12;

/** The size below which the cut is thickened so that it does not close up. */
export const THICKEN_BELOW = 24;

/** The geometry of the divided disc at one size, in pixels, in the cut's own (rotated) frame. */
export type DiscGeometry = {
	/** The side of the square the disc sits in. */
	size: number;
	/** The centre's coordinate on both axes. */
	centre: number;
	/** The disc's radius. */
	radius: number;
	/** The cut line's horizontal position, before the frame is rotated. */
	cutX: number;
	/** The width of the cut, a line of negative space. */
	gap: number;
	/** The cut's tilt from the vertical, in degrees. */
	angle: number;
	/** How far the small part slides along the cut when the disc splits: 6% of the diameter. */
	slide: number;
};

/**
 * The divided disc's geometry at a given size. The cut is a thin line at display sizes and grows,
 * relative to the disc, below 24 px, and is never under one pixel.
 */
export function discGeometry(size: number): DiscGeometry {
	if (!Number.isFinite(size) || size <= 0)
		throw new Error(`a disc needs a positive size, got ${size}`);
	const radius = size / 2;
	const fraction = size < THICKEN_BELOW ? 0.075 : 0.03;
	return {
		size,
		centre: radius,
		radius,
		cutX: CUT_POSITION * size,
		gap: Math.max(size * fraction, 1),
		angle: CUT_ANGLE_DEGREES,
		slide: size * 0.06,
	};
}
