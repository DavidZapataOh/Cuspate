// Adapted in structure from smartcontractkit/cre-templates (MIT, commit d0223f3), the TypeScript
// starter templates: a validated configuration and one cron handler.
import {
	CronCapability,
	EVMClient,
	getNetwork,
	handler,
	type Runtime,
} from "@chainlink/cre-sdk";
import { ISSUERS, issuer as profileOf } from "cuspate-shared";
import { type Address, type Hex, zeroAddress } from "viem";
import { z } from "zod";
import {
	type EventView,
	encodeReport,
	notBeforeOf,
	readContext,
	readEvent,
	screen,
	submit,
} from "./chain";
import { readFigure } from "./fetch";
import { scale } from "./source";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The most events one issuer may carry. A run reads two values about the resolver and two about each
 * event, and the platform allows a run fifteen chain reads.
 */
export const MAX_EVENTS_PER_ISSUER = 6;

/**
 * How long after its announcement an event stays due, unless the configuration says otherwise: the
 * workflow reads and proposes only within this window, so an event long resolved costs nothing on
 * later runs.
 */
export const DUE_WINDOW_SECONDS = 14 * 24 * 3600;

const TEN_YEARS = 10 * 365 * 24 * 3600;

/**
 * The time between runs, which is also the rotation step: when more than one issuer is due, each run
 * serves one, the next run the next. One issuer is a feed, then an index and a release for each of
 * at most three filings, seven of the fifteen requests a run may make.
 */
export const ROTATION_SECONDS = 600;

const event = z.object({
	eventId: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "a 32-byte event id"),
	// The terms exactly as sealed, copied from the chain: the workflow abstains unless the chain agrees.
	terms: z.string(),
	// The announcement as sealed, in Unix seconds, so the workflow knows when an event is due without
	// reading the chain.
	announcesAt: z.number().int().positive(),
});

const issuerEvents = z.object({
	// The issuer, by ticker; its CIK and the figure its markets settle on come from its profile.
	issuer: z
		.string()
		.refine(
			(ticker) => ISSUERS.some((profile) => profile.ticker === ticker),
			"an issuer the workflow has a reader for",
		),
	// The fiscal quarter its events name.
	period: z.object({
		quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
		fiscalYear: z.number().int().min(1900),
	}),
	events: z
		.array(event)
		.min(1)
		.max(MAX_EVENTS_PER_ISSUER)
		.refine(
			(events) =>
				new Set(events.map((one) => one.eventId.toLowerCase())).size ===
				events.length,
			"an event listed once",
		),
});

export const configSchema = z
	.object({
		// Six fields, seconds first, as the platform's cron trigger reads them.
		schedule: z.string().regex(/^(\S+\s+){5}\S+$/, "a six-field cron schedule"),
		// The chain the resolver is on, by the platform's name for it, and whether it is a test network.
		chainSelectorName: z.string().min(1),
		isTestnet: z.boolean(),
		// The resolver, and the receiver this workflow's reports are delivered to. Zero until deployed.
		resolver: z.string().regex(ADDRESS, "an address"),
		receiver: z.string().regex(ADDRESS, "an address"),
		// Who the workflow says it is: a name and a contact address, as the SEC asks of automated clients.
		userAgent: z
			.string()
			.regex(/^\S.*\s\S+@\S+\.\S+$/, "a name and a contact address"),
		// The events the workflow proposes for, grouped by the issuer whose release settles them.
		issuers: z.array(issuerEvents),
		// How long after its announcement an event stays due; a run against a recorded release, long
		// after it, sets it longer.
		dueWindowSeconds: z
			.number()
			.int()
			.positive()
			.max(TEN_YEARS)
			.default(DUE_WINDOW_SECONDS),
	})
	.refine(
		(config) =>
			config.resolver === zeroAddress ||
			(config.receiver !== zeroAddress &&
				config.issuers.length > 0 &&
				config.issuers.every((group) =>
					group.events.every((one) => one.terms.length > 0),
				)),
		"a deployed configuration names its receiver, its events and their terms",
	);

export type Config = z.infer<typeof configSchema>;
type IssuerEvents = Config["issuers"][number];

/** Whether an event is within its due window at `now`, in Unix seconds. */
const due = (announcesAt: number, now: number, window: number) =>
	announcesAt <= now && now < announcesAt + window;

/**
 * One run: pick the issuer due this run, check each of its events on chain, read the figure its
 * release reports as the nodes agree on it, and propose it for every event open to a proposal. Each
 * event's outcome is logged and returned, one line per event.
 */
export const onCron = (runtime: Runtime<Config>): string => {
	const config = runtime.config;
	const finish = (result: string) => {
		for (const line of result.split("\n"))
			runtime.log(`resolver-proposer: ${line}`);
		return result;
	};
	if (config.resolver === zeroAddress) return finish("abstain:not-deployed");

	const now = Math.floor(runtime.now().getTime() / 1000);
	const dueIssuers = config.issuers.filter((group) =>
		group.events.some((one) =>
			due(one.announcesAt, now, config.dueWindowSeconds),
		),
	);
	if (dueIssuers.length === 0) return finish("idle:nothing-due");
	// The network's time is the same on every node, so every node serves the same issuer.
	const group =
		dueIssuers[Math.floor(now / ROTATION_SECONDS) % dueIssuers.length];

	const network = getNetwork({
		chainFamily: "evm",
		chainSelectorName: config.chainSelectorName,
		isTestnet: config.isTestnet,
	});
	if (!network) throw new Error(`unknown chain: ${config.chainSelectorName}`);
	const evm = new EVMClient(network.chainSelector.selector);
	return finish(serve(runtime, evm, group, now).join("\n"));
};

/** The issuer's events, each with its outcome. */
function serve(
	runtime: Runtime<Config>,
	evm: EVMClient,
	group: IssuerEvents,
	now: number,
): string[] {
	const config = runtime.config;
	const resolver = config.resolver as Address;
	const context = readContext(runtime, evm, resolver);
	const events = group.events
		.filter((one) => due(one.announcesAt, now, config.dueWindowSeconds))
		.map((one) => {
			const view: EventView = readEvent(
				runtime,
				evm,
				resolver,
				context,
				one.eventId as Hex,
			);
			const gate = screen(
				view,
				{
					receiver: config.receiver,
					terms: one.terms,
					announcesAt: BigInt(one.announcesAt),
				},
				runtime.now(),
			);
			return { one, view, gate };
		});
	const line = (id: string, result: string) =>
		`${group.issuer} ${id}: ${result}`;
	const open = events.filter(({ gate }) => !("abstain" in gate));
	const outcome =
		open.length === 0
			? undefined
			: readFigure(runtime, {
					ticker: group.issuer,
					cik: profileOf(group.issuer).cik,
					notBefore: notBeforeOf(
						open
							.map(({ view }) => view.announcesAt)
							.reduce((a, b) => (a < b ? a : b)),
					),
					userAgent: config.userAgent,
					period: group.period,
				});
	return events.map(({ one, gate }) => {
		if ("abstain" in gate) return line(one.eventId, `abstain:${gate.abstain}`);
		if (!outcome)
			throw new Error("unreachable: an open event without an outcome");
		if ("abstain" in outcome)
			return line(one.eventId, `abstain:${outcome.abstain}`);
		const printedDecimals = outcome.text.split(".")[1]?.length ?? 0;
		if (printedDecimals > gate.decimals)
			return line(one.eventId, "abstain:precision");
		const figure = scale(outcome.text, gate.decimals);
		const tx = submit(
			runtime,
			evm,
			config.receiver as Address,
			encodeReport(one.eventId as Hex, figure),
		);
		return line(one.eventId, `proposed:${outcome.text}:${tx}`);
	});
}

export const initWorkflow = (config: Config) => {
	const cron = new CronCapability();
	return [handler(cron.trigger({ schedule: config.schedule }), onCron)];
};
