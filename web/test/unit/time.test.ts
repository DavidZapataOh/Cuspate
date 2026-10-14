import assert from "node:assert/strict";
import { test } from "node:test";
import {
	announcementEt,
	announcementUtc,
	duration,
} from "../../src/lib/time.ts";

test("an announcement reads in New York time, the same on any machine", () => {
	assert.equal(announcementEt("2026-10-21T20:00:00Z"), "Oct 21, 4:00 pm ET");
	// After the clocks change on November 1, the close is 21:00 UTC.
	assert.equal(announcementEt("2026-11-02T21:00:00Z"), "Nov 2, 4:00 pm ET");
	assert.equal(announcementEt("2026-11-19T13:00:00Z"), "Nov 19, 8:00 am ET");
});

test("the UTC moment is stated exactly for the title", () => {
	assert.equal(announcementUtc("2026-10-21T20:00:00Z"), "2026-10-21 20:00 UTC");
});

test("a settlement window reads in plain words", () => {
	assert.equal(duration(600), "10 minutes");
	assert.equal(duration(60), "1 minute");
	assert.equal(duration(7_200), "2 hours");
	assert.equal(duration(3_600), "1 hour");
	assert.equal(duration(86_400), "1 day");
	assert.equal(duration(172_800), "2 days");
	assert.equal(duration(5_400), "90 minutes");
});
