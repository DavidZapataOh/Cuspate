import { describe, expect, test } from "vitest";
import { dueFollowUps, type EventView } from "../src/followups.ts";

const NOBODY = "0x0000000000000000000000000000000000000000";
const SOMEONE = "0x00000000000000000000000000000000000000d1";
const proposal = (over: Partial<EventView["rounds"][0]> = {}) => ({
	proposer: NOBODY,
	proposedAt: 0n,
	settled: false,
	disputer: NOBODY,
	ruled: false,
	...over,
});
const base: EventView = {
	round: 0,
	pendingArbitration: false,
	rounds: [proposal(), proposal()],
	liveness: 3600n,
	expiresAt: 1_000_000n,
	outcomeTimeout: 2_000_000n,
	contestTimeout: 500_000n,
};

describe("the follow-ups an event is due", () => {
	test("none while a proposal's window is open", () => {
		const open = {
			...base,
			rounds: [proposal({ proposer: SOMEONE, proposedAt: 100n }), proposal()],
		} as EventView;
		expect(dueFollowUps(open, 100n + 3599n)).toEqual([]);
	});

	test("settle once the open proposal's window has closed", () => {
		const open = {
			...base,
			rounds: [proposal({ proposer: SOMEONE, proposedAt: 100n }), proposal()],
		} as EventView;
		expect(dueFollowUps(open, 100n + 3600n)).toEqual(["settle"]);
	});

	test("nothing once the open round is settled", () => {
		const settled = {
			...base,
			rounds: [
				proposal({ proposer: SOMEONE, proposedAt: 100n, settled: true }),
				proposal(),
			],
		} as EventView;
		expect(dueFollowUps(settled, 10n ** 9n)).toEqual([]);
	});

	test("release a first contest the arbiter left past its timeout, and only once", () => {
		const disputed = {
			...base,
			round: 1,
			rounds: [proposal({ proposer: SOMEONE, disputer: SOMEONE }), proposal()],
		} as EventView;
		expect(dueFollowUps(disputed, base.contestTimeout - 1n)).toEqual([]);
		expect(dueFollowUps(disputed, base.contestTimeout)).toEqual(["release"]);
		const released = {
			...disputed,
			rounds: [
				proposal({ proposer: SOMEONE, disputer: SOMEONE, ruled: true }),
				proposal(),
			],
		} as EventView;
		expect(dueFollowUps(released, base.contestTimeout)).toEqual([]);
	});

	test("expire an event nobody proposed for, after it expires", () => {
		expect(dueFollowUps(base, base.expiresAt)).toEqual([]);
		expect(dueFollowUps(base, base.expiresAt + 1n)).toEqual(["expire"]);
	});

	test("expire an event the arbiter left past its timeout", () => {
		const pending = {
			...base,
			round: 1,
			pendingArbitration: true,
			rounds: [
				proposal({ proposer: SOMEONE, disputer: SOMEONE, ruled: true }),
				proposal({ proposer: SOMEONE, disputer: SOMEONE }),
			],
		} as EventView;
		expect(dueFollowUps(pending, base.outcomeTimeout - 1n)).toEqual([]);
		expect(dueFollowUps(pending, base.outcomeTimeout)).toEqual(["expire"]);
	});

	test("never settles while the event waits for the arbiter", () => {
		const pending = {
			...base,
			round: 1,
			pendingArbitration: true,
			rounds: [
				proposal({ proposer: SOMEONE, disputer: SOMEONE, ruled: true }),
				proposal({ proposer: SOMEONE, proposedAt: 1n, disputer: SOMEONE }),
			],
		} as EventView;
		expect(dueFollowUps(pending, 10n ** 6n)).toEqual([]);
	});
});
