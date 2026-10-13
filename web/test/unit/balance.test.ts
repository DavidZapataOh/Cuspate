import assert from "node:assert/strict";
import { test } from "node:test";
import { beamAngle, MAX_TILT_DEGREES } from "../../src/lib/balance.ts";

test("an even chance leaves the beam level", () => {
	assert.equal(beamAngle(0.5), 0);
});

test("the likelier side sinks: a likely beat tips the beat pan, on the left, down", () => {
	// SVG rotates clockwise for a positive angle, so the left pan going down is a negative angle.
	assert.ok(beamAngle(0.7) < 0);
	assert.ok(beamAngle(0.3) > 0);
	assert.equal(beamAngle(0.7), -beamAngle(0.3));
});

test("the tilt is small and bounded, even at certainty", () => {
	assert.ok(MAX_TILT_DEGREES <= 4);
	assert.equal(beamAngle(1), -MAX_TILT_DEGREES);
	assert.equal(beamAngle(0), MAX_TILT_DEGREES);
	assert.equal(beamAngle(7), -MAX_TILT_DEGREES);
});

test("a chance that is not a number leaves the beam level rather than throwing", () => {
	assert.equal(beamAngle(Number.NaN), 0);
});
