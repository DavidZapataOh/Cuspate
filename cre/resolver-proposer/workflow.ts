// Adapted in structure from smartcontractkit/cre-templates (MIT, commit d0223f3), the TypeScript
// starter templates: a validated configuration and one cron handler.
import {
	CronCapability,
	EVMClient,
	getNetwork,
	handler,
	type Runtime,
} from "@chainlink/cre-sdk";
import { type Address, type Hex, zeroAddress } from "viem";
import { z } from "zod";
import { encodeReport, readEvent, screen, submit } from "./chain";
import { encodeOutcome, readFigure } from "./fetch";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_EVENT = `0x${"00".repeat(32)}`;

export const configSchema = z
	.object({
		// Six fields, seconds first, as the platform's cron trigger reads them.
		schedule: z.string().regex(/^(\S+\s+){5}\S+$/, "a six-field cron schedule"),
		// The chain the resolver is on, by the platform's name for it.
		chainSelectorName: z.string().min(1),
		// The resolver, and the receiver this workflow's reports are delivered to. Zero until deployed.
		resolver: z.string().regex(ADDRESS, "an address"),
		receiver: z.string().regex(ADDRESS, "an address"),
		// The event, and its terms exactly as sealed: the workflow abstains unless the chain agrees.
		eventId: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "a 32-byte event id"),
		terms: z.string(),
		// The issuer's SEC Central Index Key, as EDGAR's archive paths write it: no leading zeros.
		cik: z.string().regex(/^[1-9]\d*$/, "a CIK without leading zeros"),
		// Who the workflow says it is: a name and a contact address, as the SEC asks of automated clients.
		userAgent: z
			.string()
			.regex(/^\S.*\s\S+@\S+\.\S+$/, "a name and a contact address"),
		// The fiscal quarter the terms name.
		period: z.object({
			quarter: z.union([
				z.literal(1),
				z.literal(2),
				z.literal(3),
				z.literal(4),
			]),
			fiscalYear: z.number().int().min(1900),
		}),
	})
	.refine(
		(config) =>
			config.resolver === zeroAddress ||
			(config.receiver !== zeroAddress &&
				config.eventId !== ZERO_EVENT &&
				config.terms.length > 0),
		"a deployed configuration names its receiver, its event and its terms",
	);

export type Config = z.infer<typeof configSchema>;

/**
 * One run: check on chain that the event is the configured one and open to a proposal, read the
 * figure the release reports as the nodes agree on it, and propose it through the receiver.
 * Anything short of that is an abstention, logged and returned.
 */
export const onCron = (runtime: Runtime<Config>): string => {
	const config = runtime.config;
	const finish = (result: string) => {
		runtime.log(`resolver-proposer: ${result}`);
		return result;
	};
	if (config.resolver === zeroAddress) return finish("abstain:not-deployed");

	const network = getNetwork({
		chainFamily: "evm",
		chainSelectorName: config.chainSelectorName,
		isTestnet: false,
	});
	if (!network) throw new Error(`unknown chain: ${config.chainSelectorName}`);
	const evm = new EVMClient(network.chainSelector.selector);

	const view = readEvent(
		runtime,
		evm,
		config.resolver as Address,
		config.eventId as Hex,
	);
	const gate = screen(view, config, runtime.now());
	if ("abstain" in gate) return finish(`abstain:${gate.abstain}`);

	const outcome = readFigure(runtime, {
		cik: config.cik,
		notBefore: gate.notBefore,
		userAgent: config.userAgent,
		period: config.period,
		decimals: gate.decimals,
	});
	if ("abstain" in outcome) return finish(encodeOutcome(outcome));

	const tx = submit(
		runtime,
		evm,
		config.receiver as Address,
		encodeReport(config.eventId as Hex, outcome),
	);
	return finish(`proposed:${outcome.text}:${tx}`);
};

export const initWorkflow = (config: Config) => {
	const cron = new CronCapability();
	return [handler(cron.trigger({ schedule: config.schedule }), onCron)];
};
