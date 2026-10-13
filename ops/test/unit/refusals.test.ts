import { describe, expect, test } from "vitest";
import { refuseBroadcast } from "../../src/runbook.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const passed = { commit: COMMIT, passed: true };

describe("a broadcast", () => {
	test("goes ahead on the test network after a rehearsal of this exact, clean commit", () => {
		expect(refuseBroadcast(10143, {}, COMMIT, true, passed)).toBeNull();
	});

	test("is refused on the production chain whatever the rehearsal said", () => {
		expect(refuseBroadcast(143, {}, COMMIT, true, passed)).toMatch(
			/production chain/,
		);
	});

	test("is refused while the manifest holds placeholders", () => {
		expect(
			refuseBroadcast(10143, { placeholders: true }, COMMIT, true, passed),
		).toMatch(/placeholders/);
	});

	test("is refused from a tree with uncommitted changes", () => {
		expect(refuseBroadcast(10143, {}, COMMIT, false, passed)).toMatch(
			/uncommitted/,
		);
	});

	test("is refused with no rehearsal, a failed one, or one of another commit", () => {
		expect(refuseBroadcast(10143, {}, COMMIT, true, null)).toMatch(
			/no rehearsal/,
		);
		expect(
			refuseBroadcast(10143, {}, COMMIT, true, {
				commit: COMMIT,
				passed: false,
			}),
		).toMatch(/no rehearsal/);
		expect(
			refuseBroadcast(10143, {}, COMMIT, true, {
				commit: "f".repeat(40),
				passed: true,
			}),
		).toMatch(/ran on/);
	});
});
