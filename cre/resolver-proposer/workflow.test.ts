import { describe, expect } from "bun:test";
import { getNetwork } from "@chainlink/cre-sdk";
import {
	addContractMock,
	EvmMock,
	HttpActionsMock,
	newTestRuntime,
	test,
} from "@chainlink/cre-sdk/test";
import { bytesToHex, decodeAbiParameters, toHex } from "viem";
import { REGISTRY_ABI, REPORT_GAS_LIMIT, RESOLVER_ABI } from "./chain";
import committed from "./config.json";
import { feedUrl } from "./fetch";
import { type Config, configSchema, initWorkflow, onCron } from "./workflow";

const RESOLVER = "0x00000000000000000000000000000000000000e1";
const REGISTRY = "0x00000000000000000000000000000000000000e2";
const RECEIVER = "0x00000000000000000000000000000000000000c1";
const SEALER = "0x00000000000000000000000000000000000000a1";
const NOBODY = "0x0000000000000000000000000000000000000000";
const EVENT = `0x${"ab".repeat(32)}` as const;
const TERMS =
	"Micron Technology non-GAAP diluted earnings per share, fiscal Q4 2026, as first published";
// 2026-09-30T20:00:00Z, the fourth quarter's announcement.
const ANNOUNCES_AT = 1790798400n;

const live: Config = configSchema.parse({
	...committed,
	resolver: RESOLVER,
	receiver: RECEIVER,
	eventId: EVENT,
	terms: TERMS,
	period: { quarter: 4, fiscalYear: 2026 },
});
const refused = (change: Record<string, unknown>) =>
	!configSchema.safeParse({ ...committed, ...change }).success;

const fixture = async (file: string) =>
	Buffer.from(await Bun.file(`${import.meta.dir}/fixtures/${file}`).bytes());
const archive =
	"https://www.sec.gov/Archives/edgar/data/723125/000072312526000018";
const edgar: Record<string, Buffer> = {
	[feedUrl("723125")]: await fixture("edgar-8k-feed-0000723125.xml"),
	[`${archive}/index.json`]: await fixture("0000723125-26-000018-index.json"),
	[`${archive}/a2026q4ex991-pressrelease.htm`]: await fixture(
		"0000723125-26-000018-ex991.htm",
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

/** The chain and EDGAR as the workflow finds them; returns what was written. */
function world(openProposer = NOBODY) {
	const network = getNetwork({
		chainFamily: "evm",
		chainSelectorName: "monad-mainnet",
		isTestnet: false,
	});
	if (!network) throw new Error("monad-mainnet is not a network the SDK knows");
	const evm = EvmMock.testInstance(network.chainSelector.selector);
	const resolver = addContractMock(evm, {
		address: RESOLVER,
		abi: RESOLVER_ABI,
	});
	resolver.REGISTRY = () => REGISTRY;
	resolver.SEALER = () => SEALER;
	resolver.eventOf = () => ({
		round: 0,
		pendingArbitration: false,
		rounds: [proposal(openProposer), proposal(NOBODY)],
		outcomeReason: "",
	});
	const registry = addContractMock(evm, {
		address: REGISTRY,
		abi: REGISTRY_ABI,
	});
	registry.sealOf = () => [
		SEALER,
		1n,
		{
			value: 3000n,
			decimals: 2,
			announcesAt: ANNOUNCES_AT,
			deadline: ANNOUNCES_AT + 691_200n,
			terms: toHex(TERMS),
		},
	];
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
	HttpActionsMock.testInstance().sendRequest = (input) => {
		const page = edgar[input.url];
		return page
			? { statusCode: 200, body: page.toString("base64") }
			: { statusCode: 404 };
	};
	return written;
}

function runAt(config: Config, seconds: bigint) {
	const runtime = newTestRuntime(null, undefined, config);
	runtime.setTimeProvider(() => Number(seconds) * 1000);
	return { runtime, result: onCron(runtime) };
}

describe("configuration", () => {
	test("the committed configuration is valid", () => {
		expect(configSchema.safeParse(committed).success).toBe(true);
	});

	test("the committed sender is reached at the project's own domain, never at a person's address", () => {
		// The address travels in every request to the SEC and is published with the repository.
		expect(committed.userAgent).toMatch(/^Cuspate [a-z]+@cuspate\.xyz$/);
	});

	test("a schedule without seconds is refused", () => {
		expect(refused({ schedule: "*/10 * * * *" })).toBe(true);
	});

	test("an issuer named other than by its bare CIK is refused", () => {
		for (const cik of ["0000723125", "MU", "", "72312a"])
			expect(refused({ cik })).toBe(true);
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
			expect(refused({ period })).toBe(true);
		}
	});

	test("addresses and the event are refused unless well formed", () => {
		expect(refused({ resolver: "0x1234" })).toBe(true);
		expect(refused({ receiver: `0x${"g".repeat(40)}` })).toBe(true);
		expect(refused({ eventId: `0x${"ab".repeat(31)}` })).toBe(true);
	});

	test("a deployed configuration names its receiver, its event and the terms it was written for", () => {
		const deployed = {
			resolver: RESOLVER,
			receiver: RECEIVER,
			eventId: EVENT,
			terms: TERMS,
		};
		expect(refused(deployed)).toBe(false);
		expect(refused({ ...deployed, receiver: NOBODY })).toBe(true);
		expect(refused({ ...deployed, eventId: `0x${"00".repeat(32)}` })).toBe(
			true,
		);
		expect(refused({ ...deployed, terms: "" })).toBe(true);
	});
});

describe("the workflow", () => {
	test("registers exactly one handler, on the cron trigger", () => {
		expect(initWorkflow(configSchema.parse(committed))).toHaveLength(1);
	});

	test("proposes the figure the release reports, through the receiver, with the measured gas", () => {
		const written = world();
		const { result } = runAt(live, ANNOUNCES_AT + 3600n);
		expect(result).toBe(`proposed:33.42:0x${"07".repeat(32)}`);
		expect(written.length).toBe(1);
		expect(written[0].receiver).toBe(RECEIVER);
		expect(written[0].gasLimit).toBe(REPORT_GAS_LIMIT);
	});

	test("reports what it decided in its log", () => {
		world();
		const { runtime } = runAt(live, ANNOUNCES_AT + 3600n);
		expect(
			runtime.getLogs().some((line) => line.includes("proposed:33.42")),
		).toBe(true);
	});

	test("abstains, writing nothing, before the announcement", () => {
		const written = world();
		expect(runAt(live, ANNOUNCES_AT - 60n).result).toBe("abstain:too-early");
		expect(written.length).toBe(0);
	});

	test("abstains, writing nothing, when a proposal is already open", () => {
		const written = world("0x00000000000000000000000000000000000000d1");
		expect(runAt(live, ANNOUNCES_AT + 3600n).result).toBe("abstain:proposed");
		expect(written.length).toBe(0);
	});

	test("abstains, writing nothing, when the release cannot be read", () => {
		const written = world();
		const q1 = { ...live, period: { quarter: 1, fiscalYear: 2027 } } as Config;
		expect(runAt(q1, ANNOUNCES_AT + 3600n).result).toBe(
			"abstain:period-not-found",
		);
		expect(written.length).toBe(0);
	});

	test("abstains, reading nothing, while the configuration names no deployed contracts", () => {
		const written = world();
		const asked: string[] = [];
		HttpActionsMock.testInstance().sendRequest = (input) => {
			asked.push(input.url);
			return { statusCode: 404 };
		};
		expect(runAt(configSchema.parse(committed), ANNOUNCES_AT).result).toBe(
			"abstain:not-deployed",
		);
		expect(asked).toEqual([]);
		expect(written.length).toBe(0);
	});

	test("writes the report the receiver decodes", () => {
		const written = world();
		runAt(live, ANNOUNCES_AT + 3600n);
		// The test runtime signs nothing: its report is the payload after the metadata the
		// forwarder strips, which is what reaches the receiver.
		const raw = written[0].report;
		const payload = bytesToHex(raw.slice(raw.length - 96));
		expect(
			decodeAbiParameters(
				[{ type: "bytes32" }, { type: "int256" }, { type: "uint8" }],
				payload,
			),
		).toEqual([EVENT, 3342n, 2]);
	});
});
