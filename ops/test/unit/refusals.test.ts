import { describe, expect, test } from "vitest";
import {
	refuseBroadcast,
	rehearsalBook,
	stepStatus,
} from "../../src/runbook.ts";

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

describe("a step already on chain", () => {
	const address = "0x00000000000000000000000000000000000000a1";

	test("is skipped when a record names it and its code is there, as a resumed run skips it", () => {
		expect(stepStatus("TestnetDollar", address, { address }, "0x6080")).toBe(
			"skip",
		);
	});

	test("is refused when its code is there and no record names it anywhere", () => {
		expect(() =>
			stepStatus("TestnetDollar", address, undefined, "0x6080"),
		).toThrow(/code exists at .* with no record/);
	});

	test("is sent when nothing is there yet", () => {
		expect(stepStatus("TestnetDollar", address, undefined, "0x")).toBe("send");
		expect(stepStatus("TestnetDollar", address, undefined, undefined)).toBe(
			"send",
		);
	});
});

describe("a rehearsal's book", () => {
	test("starts from the chain's committed record, so a deployment already made is not refused", () => {
		const committed = {
			TestnetDollar: { address: "0x00000000000000000000000000000000000000a1" },
			roles: {
				arbiter: { address: "0x00000000000000000000000000000000000000b2" },
			},
		};
		const book = rehearsalBook(
			committed as never,
			{ deployer: "0x00000000000000000000000000000000000000c3" } as never,
			{ dollar: ["0x00000000000000000000000000000000000000d4"] } as never,
		);
		expect(book.TestnetDollar).toEqual(committed.TestnetDollar);
		expect(book.roles).toEqual(committed.roles);
		expect(book.manifest).toBeDefined();
		expect(book.thirdParty).toBeDefined();
	});
});
