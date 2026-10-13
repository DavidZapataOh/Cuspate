/** The largest tilt the beam takes, in degrees: small, so it reads as a measure and not as a bet. */
export const MAX_TILT_DEGREES = 3.5;

/**
 * The beam's angle for the chance that the condition is met. The likelier side sinks: the beat pan
 * hangs on the left, so a likely beat is a negative (anticlockwise) angle. A chance outside [0, 1]
 * is held at the bound; one that is not a number leaves the beam level.
 */
export function beamAngle(chance: number): number {
	if (Number.isNaN(chance)) return 0;
	const bounded = Math.min(Math.max(chance, 0), 1);
	// Rounded to a hundredth of a degree, so that equal and opposite chances give equal and opposite
	// angles rather than two floating-point neighbours.
	const angle = Math.round(-(bounded - 0.5) * 2 * MAX_TILT_DEGREES * 100) / 100;
	return Object.is(angle, -0) ? 0 : angle;
}
