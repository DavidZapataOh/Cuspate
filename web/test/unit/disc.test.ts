import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CUT_ANGLE_DEGREES,
	CUT_POSITION,
	discGeometry,
} from "../../src/lib/disc.ts";

test("the cut sits 72/28 across the disc, never through its centre", () => {
	assert.equal(CUT_POSITION, 0.72);
	const g = discGeometry(128);
	assert.equal(g.radius, 64);
	// Measured along the axis perpendicular to the cut, from the large part's far edge.
	assert.equal((g.cutX - (g.centre - g.radius)) / (2 * g.radius), 0.72);
});

test("the cut is tilted twelve degrees from the vertical", () => {
	assert.equal(CUT_ANGLE_DEGREES, 12);
	assert.equal(discGeometry(64).angle, 12);
});

test("the cut is a thin line at display sizes and thickens below 24 px so it never closes", () => {
	const large = discGeometry(128);
	const small = discGeometry(16);
	assert.ok(large.gap / 128 < 0.05, "the cut is not thin at 128 px");
	assert.ok(
		small.gap / 16 > large.gap / 128,
		"the cut does not thicken at 16 px",
	);
	assert.ok(small.gap >= 1, "the cut is under one pixel at 16 px");
	assert.equal(
		discGeometry(64).gap / 64,
		large.gap / 128,
		"above the threshold the cut keeps its proportion",
	);
	assert.ok(
		discGeometry(23).gap / 23 > discGeometry(24).gap / 24,
		"24 px is the threshold",
	);
});

test("the slide that splits the disc is six per cent of its diameter", () => {
	assert.equal(discGeometry(100).slide, 6);
});

test("a disc of no size is refused", () => {
	assert.throws(() => discGeometry(0));
	assert.throws(() => discGeometry(Number.NaN));
});
