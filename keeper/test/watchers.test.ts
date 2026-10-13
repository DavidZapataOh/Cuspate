import { describe, expect, test } from "vitest";
import type { EventView } from "../src/followups.ts";
import {
	capWatcher,
	clockWatcher,
	freezeWatcher,
	oracleWatcher,
	solvencyWatcher,
} from "../src/watchers.ts";

const VAULT = "0x00000000000000000000000000000000000000a1";

describe("solvency", () => {
	const vault = {
		vault: VAULT,
		balance: 1000n,
		yesSupply: 1000n,
		noSupply: 1000n,
		outcome: 0,
	};

	test("holds while the vault keeps its collateral, and a donation's surplus is no alert", () => {
		expect(solvencyWatcher(vault)).toEqual([]);
		expect(solvencyWatcher({ ...vault, balance: 5000n })).toEqual([]);
	});

	test("is breached by a single unit short of the legs, before resolution", () => {
		const [alert] = solvencyWatcher({ ...vault, balance: 999n });
		expect(alert).toMatchObject({
			severity: "critical",
			watcher: "solvency",
			subject: VAULT,
		});
	});

	test("is breached when the legs' supplies part, which no split or merge can do", () => {
		expect(solvencyWatcher({ ...vault, noSupply: 999n })[0]).toMatchObject({
			severity: "critical",
			watcher: "solvency",
		});
	});

	test("after resolution, owes what redemption pays: the winning leg twice over half, or half of each", () => {
		// Yes: every yes leg redeems for one unit. Part of the market has redeemed already.
		expect(
			solvencyWatcher({
				...vault,
				balance: 600n,
				yesSupply: 600n,
				noSupply: 900n,
				outcome: 1,
			}),
		).toEqual([]);
		expect(
			solvencyWatcher({
				...vault,
				balance: 599n,
				yesSupply: 600n,
				noSupply: 900n,
				outcome: 1,
			}),
		).toHaveLength(1);
		// No.
		expect(
			solvencyWatcher({
				...vault,
				balance: 900n,
				yesSupply: 600n,
				noSupply: 900n,
				outcome: 2,
			}),
		).toEqual([]);
		expect(
			solvencyWatcher({
				...vault,
				balance: 899n,
				yesSupply: 600n,
				noSupply: 900n,
				outcome: 2,
			}),
		).toHaveLength(1);
		// Invalid: half of each.
		expect(
			solvencyWatcher({
				...vault,
				balance: 750n,
				yesSupply: 600n,
				noSupply: 900n,
				outcome: 3,
			}),
		).toEqual([]);
		expect(
			solvencyWatcher({
				...vault,
				balance: 749n,
				yesSupply: 600n,
				noSupply: 900n,
				outcome: 3,
			}),
		).toHaveLength(1);
	});
});

describe("caps", () => {
	test("warns only when the room left is within a hundredth of the cap", () => {
		expect(
			capWatcher({ vault: VAULT, cap: 10_000n, yesSupply: 9_899n }),
		).toEqual([]);
		expect(
			capWatcher({ vault: VAULT, cap: 10_000n, yesSupply: 9_900n })[0],
		).toMatchObject({ severity: "warning", watcher: "cap" });
	});
});

describe("the oracle", () => {
	const quote = {
		price: 100n,
		bid: 99n,
		ask: 101n,
		publishedAt: 1000n,
		session: 1,
	};

	test("is quiet on an open, fresh, sane feed, and on a closed one", () => {
		expect(oracleWatcher(quote, 1100n)).toEqual([]);
		expect(
			oracleWatcher({ ...quote, session: 0, publishedAt: 0n }, 10_000n),
		).toEqual([]);
	});

	test("warns on a feed older than 1,500 seconds while the market is open", () => {
		expect(oracleWatcher(quote, 2500n)).toEqual([]);
		expect(oracleWatcher(quote, 2501n)[0]).toMatchObject({
			severity: "warning",
			watcher: "oracle",
		});
	});

	test("alerts on a quote that makes no sense while the market is open", () => {
		expect(oracleWatcher({ ...quote, bid: 102n }, 1100n)[0]).toMatchObject({
			severity: "critical",
			watcher: "oracle",
		});
		expect(oracleWatcher({ ...quote, price: 0n }, 1100n)[0]).toMatchObject({
			severity: "critical",
			watcher: "oracle",
		});
	});
});

describe("the resolver's clocks", () => {
	const NOBODY = "0x0000000000000000000000000000000000000000";
	const SOMEONE = "0x00000000000000000000000000000000000000d1";
	const round = (over = {}) => ({
		proposer: NOBODY,
		proposedAt: 0n,
		settled: false,
		disputer: NOBODY,
		ruled: false,
		...over,
	});
	const event = (over: Partial<EventView> = {}): EventView => ({
		round: 0,
		pendingArbitration: false,
		rounds: [round({ proposer: SOMEONE, proposedAt: 1000n }), round()],
		liveness: 3600n,
		expiresAt: 10n ** 9n,
		outcomeTimeout: 10n ** 9n,
		contestTimeout: 10n ** 9n,
		...over,
	});

	test("are quiet while every follow-up due was taken within the grace", () => {
		expect(clockWatcher("0xe1", event(), 1000n + 3600n + 600n, 600n)).toEqual(
			[],
		);
	});

	test("warn when a follow-up stays due past the grace: the keeper is not taking it", () => {
		expect(
			clockWatcher("0xe1", event(), 1000n + 3600n + 601n, 600n)[0],
		).toMatchObject({ severity: "warning", watcher: "clock", subject: "0xe1" });
	});

	test("warn when the arbiter has less than a day left to rule", () => {
		const pending = event({
			round: 1,
			pendingArbitration: true,
			outcomeTimeout: 100_000n,
		});
		expect(
			clockWatcher("0xe1", pending, 100_000n - 86_400n - 1n, 600n),
		).toEqual([]);
		expect(
			clockWatcher("0xe1", pending, 100_000n - 86_400n, 600n)[0],
		).toMatchObject({ severity: "warning", watcher: "clock" });
	});
});

describe("the freeze", () => {
	test("warns when a market was frozen before its announcement", () => {
		expect(
			freezeWatcher({ market: "0xm1", freezesAt: 500n, announcesAt: 500n }),
		).toEqual([]);
		expect(
			freezeWatcher({ market: "0xm1", freezesAt: 400n, announcesAt: 500n })[0],
		).toMatchObject({ severity: "warning", watcher: "freeze" });
	});
});
