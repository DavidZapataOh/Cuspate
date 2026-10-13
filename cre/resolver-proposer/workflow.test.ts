import { describe, expect } from "bun:test";
import { getNetwork } from "@chainlink/cre-sdk";
import {
	addContractMock,
	EvmMock,
	HttpActionsMock,
	newTestRuntime,
	test,
} from "@chainlink/cre-sdk/test";
import { bytesToHex, decodeAbiParameters, type Hex, toHex } from "viem";
import { REGISTRY_ABI, REPORT_GAS_LIMIT, RESOLVER_ABI } from "./chain";
import committed from "./config.json";
import { feedUrl } from "./fetch";
import {
	type Config,
	configSchema,
	DUE_WINDOW_SECONDS,
	initWorkflow,
	MAX_EVENTS_PER_ISSUER,
	onCron,
	ROTATION_SECONDS,
} from "./workflow";

const RESOLVER = "0x00000000000000000000000000000000000000e1";
const REGISTRY = "0x00000000000000000000000000000000000000e2";
const RECEIVER = "0x00000000000000000000000000000000000000c1";
const SEALER = "0x00000000000000000000000000000000000000a1";
const NOBODY = "0x0000000000000000000000000000000000000000";
const event = (byte: string) => `0x${byte.repeat(32)}` as Hex;
// 2026-09-30T20:00:00Z, Micron's fourth-quarter announcement.
const MU_AT = 1790798400n;

type Sealed = { terms: string; announcesAt: bigint; decimals: number };
// What the chain holds, event by event.
const CHAIN: Record<string, Sealed> = {
	[event("a1")]: { terms: "MU above 30.00", announcesAt: MU_AT, decimals: 2 },
	[event("a2")]: { terms: "MU above 34.00", announcesAt: MU_AT, decimals: 2 },
	// Due at the same time as Micron's, to test that one run serves one issuer.
	[event("b1")]: { terms: "NVDA above 2.10", announcesAt: MU_AT, decimals: 2 },
};
const configured = (id: Hex) => ({
	eventId: id,
	terms: CHAIN[id].terms,
	announcesAt: Number(CHAIN[id].announcesAt),
});

const micron = {
	issuer: "MU",
	period: { quarter: 4, fiscalYear: 2026 },
	events: [configured(event("a1")), configured(event("a2"))],
};
const nvidia = {
	issuer: "NVDA",
	period: { quarter: 2, fiscalYear: 2027 },
	events: [configured(event("b1"))],
};
const deployed = {
	...committed,
	resolver: RESOLVER,
	receiver: RECEIVER,
	issuers: [micron],
};
const live: Config = configSchema.parse(deployed);
const refused = (change: Record<string, unknown>) =>
	!configSchema.safeParse({ ...deployed, ...change }).success;

const fixture = async (file: string) =>
	Buffer.from(await Bun.file(`${import.meta.dir}/fixtures/${file}`).bytes());
const mu = "https://www.sec.gov/Archives/edgar/data/723125/000072312526000018";
const nv = "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073";
const edgar: Record<string, Buffer> = {
	[feedUrl("723125")]: await fixture("edgar-8k-feed-0000723125.xml"),
	[`${mu}/0000723125-26-000018-index.html`]: await fixture(
		"0000723125-26-000018-index.html",
	),
	[`${mu}/a2026q4ex991-pressrelease.htm`]: await fixture(
		"0000723125-26-000018-ex991.htm",
	),
	[feedUrl("1045810")]: await fixture("NVDA/edgar-8k-feed-1045810.xml"),
	[`${nv}/0001045810-26-000073-index.html`]: await fixture(
		"NVDA/0001045810-26-000073-index.html",
	),
	[`${nv}/q2fy27pr.htm`]: await fixture(
		"NVDA/0001045810-26-000073-q2fy27pr.htm",
	),
};

const proposal = (proposer: string) => ({
	proposer,
	proposedAt: 0n,
	invalid: false,
	settled: false,
	figure: 0n,
	decimals: 0,
	disputer: NOBODY,
	ruled: false,
	ruledAt: 0n,
	reason: "",
});

/**
 * The chain and EDGAR as the workflow finds them, on the named network; returns what was written and
 * what was asked of each.
 */
function world(
	options: { proposed?: Hex[]; chain?: string; testnet?: boolean } = {},
) {
	const network = getNetwork({
		chainFamily: "evm",
		chainSelectorName: options.chain ?? "monad-mainnet",
		isTestnet: options.testnet ?? false,
	});
	if (!network) throw new Error("not a network the SDK knows");
	const evm = EvmMock.testInstance(network.chainSelector.selector);
	const reads: string[] = [];
	const resolver = addContractMock(evm, {
		address: RESOLVER,
		abi: RESOLVER_ABI,
	});
	resolver.REGISTRY = () => {
		reads.push("REGISTRY");
		return REGISTRY;
	};
	resolver.SEALER = () => {
		reads.push("SEALER");
		return SEALER;
	};
	resolver.eventOf = (id: unknown) => {
		reads.push(`eventOf ${id}`);
		const open = options.proposed?.includes(id as Hex)
			? "0x00000000000000000000000000000000000000d1"
			: NOBODY;
		return {
			round: 0,
			pendingArbitration: false,
			rounds: [proposal(open), proposal(NOBODY)],
			outcomeReason: "",
		};
	};
	const registry = addContractMock(evm, {
		address: REGISTRY,
		abi: REGISTRY_ABI,
	});
	registry.sealOf = (id: unknown) => {
		reads.push(`sealOf ${id}`);
		const sealed = CHAIN[id as Hex];
		return [
			SEALER,
			1n,
			{
				value: 3000n,
				decimals: sealed.decimals,
				announcesAt: sealed.announcesAt,
				deadline: sealed.announcesAt + 691_200n,
				terms: toHex(sealed.terms),
			},
		];
	};
	const written: { receiver: string; gasLimit: string; report: Uint8Array }[] =
		[];
	evm.writeReport = (input) => {
		written.push({
			receiver: bytesToHex(input.receiver),
			gasLimit: String(input.gasConfig?.gasLimit ?? ""),
			report: input.report?.rawReport ?? new Uint8Array(),
		});
		return {
			txStatus: "TX_STATUS_SUCCESS",
			txHash: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
		};
	};
	const asked: string[] = [];
	HttpActionsMock.testInstance().sendRequest = (input) => {
		asked.push(input.url);
		const page = edgar[input.url];
		return page
			? { statusCode: 200, body: page.toString("base64") }
			: { statusCode: 404 };
	};
	return { written, reads, asked };
}

function runAt(config: Config, seconds: bigint) {
	const runtime = newTestRuntime(null, undefined, config);
	runtime.setTimeProvider(() => Number(seconds) * 1000);
	return { runtime, result: onCron(runtime) };
}

/** The event, figure and decimals a written report carries, as the receiver decodes it. */
function decoded(report: Uint8Array) {
	// The test runtime signs nothing: its report is the payload after the metadata the forwarder
	// strips, which is what reaches the receiver.
	return decodeAbiParameters(
		[{ type: "bytes32" }, { type: "int256" }, { type: "uint8" }],
		bytesToHex(report.slice(report.length - 96)),
	);
}

describe("configuration", () => {
	test("the committed configuration is valid, and names no deployment yet", () => {
		const parsed = configSchema.parse(committed);
		expect(parsed.resolver).toBe(NOBODY);
		expect(parsed.issuers).toEqual([]);
	});

	test("the committed sender is reached at the project's own domain, never at a person's address", () => {
		// The address travels in every request to the SEC and is published with the repository.
		expect(committed.userAgent).toMatch(/^Cuspate [a-z]+@cuspate\.xyz$/);
	});

	test("the committed schedule fires once per rotation step", () => {
		expect(committed.schedule).toBe(`0 */${ROTATION_SECONDS / 60} * * * *`);
	});

	test("a schedule without seconds is refused", () => {
		expect(refused({ schedule: "*/10 * * * *" })).toBe(true);
	});

	test("an issuer no reader serves is refused", () => {
		for (const issuer of ["XYZ", "mu", ""])
			expect(refused({ issuers: [{ ...micron, issuer }] })).toBe(true);
	});

	test("a sender that names no contact address is refused", () => {
		// The SEC asks automated clients to declare who they are and how to reach them.
		for (const userAgent of ["", "Cuspate", "bun/1.4"])
			expect(refused({ userAgent })).toBe(true);
	});

	test("a period the terms could not name is refused", () => {
		for (const period of [
			{ quarter: 0, fiscalYear: 2027 },
			{ quarter: 5, fiscalYear: 2027 },
			{ quarter: 1, fiscalYear: 27.5 },
		]) {
			expect(refused({ issuers: [{ ...micron, period }] })).toBe(true);
		}
	});

	test("addresses and events are refused unless well formed", () => {
		expect(refused({ resolver: "0x1234" })).toBe(true);
		expect(refused({ receiver: `0x${"g".repeat(40)}` })).toBe(true);
		const bad = { ...micron.events[0], eventId: `0x${"ab".repeat(31)}` };
		expect(refused({ issuers: [{ ...micron, events: [bad] }] })).toBe(true);
	});

	test("an issuer carries no more events than one run can read", () => {
		const many = Array.from(
			{ length: MAX_EVENTS_PER_ISSUER + 1 },
			(_, index) => ({
				...micron.events[0],
				eventId: `0x${index.toString(16).padStart(64, "0")}`,
			}),
		);
		expect(refused({ issuers: [{ ...micron, events: many }] })).toBe(true);
		expect(
			refused({
				issuers: [{ ...micron, events: many.slice(0, MAX_EVENTS_PER_ISSUER) }],
			}),
		).toBe(false);
	});

	test("a due window is a whole number of seconds, at most ten years", () => {
		expect(refused({ dueWindowSeconds: 0 })).toBe(true);
		expect(refused({ dueWindowSeconds: 1.5 })).toBe(true);
		expect(refused({ dueWindowSeconds: 10 * 366 * 24 * 3600 })).toBe(true);
		expect(refused({ dueWindowSeconds: 3600 })).toBe(false);
	});

	test("an event listed twice is refused", () => {
		const twice = [micron.events[0], micron.events[0]];
		expect(refused({ issuers: [{ ...micron, events: twice }] })).toBe(true);
	});

	test("a deployed configuration names its receiver, its events and the terms each was written for", () => {
		expect(refused({})).toBe(false);
		expect(refused({ receiver: NOBODY })).toBe(true);
		expect(refused({ issuers: [] })).toBe(true);
		expect(
			refused({
				issuers: [{ ...micron, events: [{ ...micron.events[0], terms: "" }] }],
			}),
		).toBe(true);
	});
});

describe("the workflow", () => {
	test("registers exactly one handler, on the cron trigger", () => {
		expect(initWorkflow(configSchema.parse(committed))).toHaveLength(1);
	});

	test("proposes the release's figure for every open event of the issuer, through the receiver, with the measured gas", () => {
		const { written } = world();
		const { result } = runAt(live, MU_AT + 3600n);
		expect(result).toBe(
			[
				`MU ${event("a1")}: proposed:33.42:0x${"07".repeat(32)}`,
				`MU ${event("a2")}: proposed:33.42:0x${"07".repeat(32)}`,
			].join("\n"),
		);
		expect(written.map((report) => decoded(report.report))).toEqual([
			[event("a1"), 3342n, 2],
			[event("a2"), 3342n, 2],
		]);
		for (const report of written) {
			expect(report.receiver).toBe(RECEIVER);
			expect(report.gasLimit).toBe(REPORT_GAS_LIMIT);
		}
	});

	test("reads EDGAR once for the issuer, and stays within the reads one run may make", () => {
		const { reads, asked } = world();
		runAt(live, MU_AT + 3600n);
		expect(asked).toEqual([
			feedUrl("723125"),
			`${mu}/0000723125-26-000018-index.html`,
			`${mu}/a2026q4ex991-pressrelease.htm`,
		]);
		expect(reads.length).toBe(2 + 2 * micron.events.length);
		expect(2 + 2 * MAX_EVENTS_PER_ISSUER).toBeLessThanOrEqual(15);
	});

	test("reports what it decided in its log", () => {
		world();
		const { runtime } = runAt(live, MU_AT + 3600n);
		expect(
			runtime.getLogs().some((line) => line.includes("proposed:33.42")),
		).toBe(true);
	});

	test("reads nothing at all while no configured event is due", () => {
		const { written, reads, asked } = world();
		expect(runAt(live, MU_AT - 60n).result).toBe("idle:nothing-due");
		expect(runAt(live, MU_AT + BigInt(DUE_WINDOW_SECONDS)).result).toBe(
			"idle:nothing-due",
		);
		expect([written.length, reads.length, asked.length]).toEqual([0, 0, 0]);
	});

	test("keeps an event due for as long as the configuration says, past the default window", () => {
		world();
		const late = MU_AT + BigInt(DUE_WINDOW_SECONDS) + 3600n;
		expect(runAt(live, late).result).toBe("idle:nothing-due");
		const longer = configSchema.parse({
			...deployed,
			dueWindowSeconds: DUE_WINDOW_SECONDS * 2,
		});
		expect(runAt(longer, late).result).toContain("proposed:33.42");
	});

	test("abstains for an event already proposed, and still proposes the others", () => {
		const { written } = world({ proposed: [event("a1")] });
		expect(runAt(live, MU_AT + 3600n).result).toBe(
			[
				`MU ${event("a1")}: abstain:proposed`,
				`MU ${event("a2")}: proposed:33.42:0x${"07".repeat(32)}`,
			].join("\n"),
		);
		expect(written.map((report) => decoded(report.report)[0])).toEqual([
			event("a2"),
		]);
	});

	test("asks EDGAR nothing when no event of the issuer is open", () => {
		const { asked, written } = world({ proposed: [event("a1"), event("a2")] });
		runAt(live, MU_AT + 3600n);
		expect([asked.length, written.length]).toEqual([0, 0]);
	});

	test("abstains, writing nothing, when the release cannot be read", () => {
		const { written } = world();
		const q1 = configSchema.parse({
			...deployed,
			issuers: [{ ...micron, period: { quarter: 1, fiscalYear: 2027 } }],
		});
		expect(runAt(q1, MU_AT + 3600n).result).toBe(
			[
				`MU ${event("a1")}: abstain:period-not-found`,
				`MU ${event("a2")}: abstain:period-not-found`,
			].join("\n"),
		);
		expect(written.length).toBe(0);
	});

	test("abstains for an event whose configured terms are not the ones sealed", () => {
		const { written } = world();
		const changed = configSchema.parse({
			...deployed,
			issuers: [
				{
					...micron,
					events: [
						{ ...micron.events[0], terms: "MU above 31.00" },
						micron.events[1],
					],
				},
			],
		});
		expect(runAt(changed, MU_AT + 3600n).result.split("\n")[0]).toBe(
			`MU ${event("a1")}: abstain:terms-mismatch`,
		);
		expect(written.length).toBe(1);
	});

	test("abstains for an event whose threshold carries fewer decimals than the printed figure", () => {
		const sealed = CHAIN[event("a2")];
		CHAIN[event("a2")] = { ...sealed, decimals: 1 };
		try {
			world();
			expect(runAt(live, MU_AT + 3600n).result.split("\n")[1]).toBe(
				`MU ${event("a2")}: abstain:precision`,
			);
		} finally {
			CHAIN[event("a2")] = sealed;
		}
	});

	test("abstains, reading nothing, while the configuration names no deployed contracts", () => {
		const { written, reads, asked } = world();
		expect(runAt(configSchema.parse(committed), MU_AT).result).toBe(
			"abstain:not-deployed",
		);
		expect([written.length, reads.length, asked.length]).toEqual([0, 0, 0]);
	});

	test("serves one issuer per run, and successive runs reach every issuer due", () => {
		const both = configSchema.parse({ ...deployed, issuers: [micron, nvidia] });
		const now = MU_AT + 3600n;
		const served = new Set<string>();
		for (let step = 0n; step < 2n; step++) {
			const { asked } = world();
			const { result } = runAt(both, now + step * BigInt(ROTATION_SECONDS));
			served.add(result.split(" ")[0]);
			// One issuer's documents only: its feed and filings carry its CIK.
			expect(
				asked.every((url) => url.includes("723125")) ||
					asked.every((url) => url.includes("1045810")),
			).toBe(true);
		}
		expect(served).toEqual(new Set(["MU", "NVDA"]));
	});

	test("resolves the test network when the configuration says so", () => {
		const { written } = world({ chain: "monad-testnet", testnet: true });
		const testnet = configSchema.parse({
			...deployed,
			chainSelectorName: "monad-testnet",
			isTestnet: true,
		});
		expect(runAt(testnet, MU_AT + 3600n).result).toContain("proposed:33.42");
		expect(written.length).toBe(2);
	});
});
