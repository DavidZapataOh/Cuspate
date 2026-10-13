import {
	bytesToHex,
	type EVMClient,
	encodeCallMsg,
	LAST_FINALIZED_BLOCK_NUMBER,
	prepareReportRequest,
	type Runtime,
	TxStatus,
} from "@chainlink/cre-sdk";
import {
	type Abi,
	type Address,
	type DecodeFunctionResultParameters,
	decodeFunctionResult,
	type EncodeFunctionDataParameters,
	encodeAbiParameters,
	encodeFunctionData,
	type Hex,
	toHex,
	zeroAddress,
} from "viem";
import type { Figure } from "./source";

/**
 * The gas the workflow asks the forwarder to deliver a report with. Measured on a fork of the
 * production chain: delivery through the forwarder, the receiver's checks and the bonded proposal
 * together use about 332,000. The network charges the limit, not what is used, so it is not padded
 * beyond the margin a forwarder's signature checks need.
 */
export const REPORT_GAS_LIMIT = "500000";

const PROPOSAL = {
	type: "tuple",
	components: [
		{ name: "proposer", type: "address" },
		{ name: "proposedAt", type: "uint256" },
		{ name: "invalid", type: "bool" },
		{ name: "settled", type: "bool" },
		{ name: "figure", type: "int256" },
		{ name: "decimals", type: "uint8" },
		{ name: "disputer", type: "address" },
		{ name: "ruled", type: "bool" },
		{ name: "ruledAt", type: "uint64" },
		{ name: "reason", type: "string" },
	],
} as const;

/** The resolver, as far as the workflow reads it. */
export const RESOLVER_ABI = [
	{
		type: "function",
		name: "REGISTRY",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "address" }],
	},
	{
		type: "function",
		name: "SEALER",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "address" }],
	},
	{
		type: "function",
		name: "eventOf",
		stateMutability: "view",
		inputs: [{ name: "eventId", type: "bytes32" }],
		outputs: [
			{
				type: "tuple",
				components: [
					{ name: "round", type: "uint8" },
					{ name: "pendingArbitration", type: "bool" },
					{ name: "rounds", type: "tuple[2]", components: PROPOSAL.components },
					{ name: "outcomeReason", type: "string" },
				],
			},
		],
	},
] as const;

/** The registry, as far as the workflow reads it. */
export const REGISTRY_ABI = [
	{
		type: "function",
		name: "sealOf",
		stateMutability: "view",
		inputs: [{ name: "eventId", type: "bytes32" }],
		outputs: [
			{ name: "sealer", type: "address" },
			{ name: "sealBlock", type: "uint256" },
			{
				name: "threshold",
				type: "tuple",
				components: [
					{ name: "value", type: "int256" },
					{ name: "decimals", type: "uint8" },
					{ name: "announcesAt", type: "uint64" },
					{ name: "deadline", type: "uint64" },
					{ name: "terms", type: "bytes" },
				],
			},
		],
	},
] as const;

/** What the workflow needs to know about an event before reading its figure. */
export type EventView = {
	/** Who sealed it; zero if nobody has. */
	sealer: Address;
	/** The only sealer whose events the resolver resolves. */
	trustedSealer: Address;
	/** The decimals of its threshold, which the figure is proposed at. */
	decimals: number;
	/** The earliest instant its figure may be public, in Unix seconds. */
	announcesAt: bigint;
	/** Its terms, as sealed. */
	terms: Hex;
	/** The round now open. */
	round: number;
	/** Whether it waits for the arbiter. */
	pendingArbitration: boolean;
	/** Who proposed in the open round; zero if nobody has. */
	openProposer: Address;
	/** Who proposed in the first round. */
	firstProposer: Address;
};

/**
 * Why the workflow does not read or propose: the event is not one the resolver resolves, its terms
 * are not the ones this configuration was written for, its figure cannot be public yet, a proposal
 * is already open, it waits for the arbiter, or the open round follows this workflow's own disputed
 * proposal.
 */
export type ChainAbstainReason =
	| "not-sealed"
	| "terms-mismatch"
	| "too-early"
	| "proposed"
	| "arbitration"
	| "own-disputed";

/**
 * The date EDGAR filings for an event can carry at the earliest: the UTC date the day before the
 * announcement. EDGAR dates a filing in New York, four or five hours behind UTC, so its date is never
 * earlier than that.
 * @param announcesAt The announcement, in Unix seconds.
 */
export function notBeforeOf(announcesAt: bigint): string {
	return new Date(Number(announcesAt - 86_400n) * 1000)
		.toISOString()
		.slice(0, 10);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether the workflow may read and propose for the event now, and if so at which decimals and from
 * which filing date. A pure function of what the chain says, so every node decides the same.
 * @param view The event, as read.
 * @param config The receiver proposing, and the terms the configuration was written for.
 * @param now The network's time.
 */
export function screen(
	view: EventView,
	config: { receiver: string; terms: string },
	now: Date,
): { abstain: ChainAbstainReason } | { decimals: number; notBefore: string } {
	if (same(view.sealer, zeroAddress) || !same(view.sealer, view.trustedSealer))
		return { abstain: "not-sealed" };
	if (view.terms !== toHex(config.terms)) return { abstain: "terms-mismatch" };
	if (BigInt(Math.floor(now.getTime() / 1000)) < view.announcesAt)
		return { abstain: "too-early" };
	if (view.pendingArbitration) return { abstain: "arbitration" };
	if (!same(view.openProposer, zeroAddress)) return { abstain: "proposed" };
	if (view.round === 1 && same(view.firstProposer, config.receiver))
		return { abstain: "own-disputed" };
	return { decimals: view.decimals, notBefore: notBeforeOf(view.announcesAt) };
}

/** The report the receiver decodes: the event, the figure scaled by `10**decimals`, the decimals. */
export function encodeReport(eventId: Hex, figure: Figure): Hex {
	return encodeAbiParameters(
		[{ type: "bytes32" }, { type: "int256" }, { type: "uint8" }],
		[eventId, figure.value, figure.decimals],
	);
}

/** One view call, at the last finalized block. */
function call(
	runtime: Runtime<unknown>,
	evm: EVMClient,
	to: Address,
	abi: Abi,
	functionName: string,
	args: readonly unknown[] = [],
): unknown {
	// The name is chosen at run time, which viem's inferred types cannot follow, so the call is typed
	// against the plain ABI and its result narrowed by the caller.
	const data = encodeFunctionData({
		abi,
		functionName,
		args,
	} as EncodeFunctionDataParameters);
	const reply = evm
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to, data }),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result();
	return decodeFunctionResult({
		abi,
		functionName,
		data: bytesToHex(reply.data),
	} as DecodeFunctionResultParameters);
}

/** The event as the resolver and its registry hold it, at the last finalized block. */
export function readEvent(
	runtime: Runtime<unknown>,
	evm: EVMClient,
	resolver: Address,
	eventId: Hex,
): EventView {
	const registry = call(
		runtime,
		evm,
		resolver,
		RESOLVER_ABI,
		"REGISTRY",
	) as Address;
	const trustedSealer = call(
		runtime,
		evm,
		resolver,
		RESOLVER_ABI,
		"SEALER",
	) as Address;
	const [sealer, , threshold] = call(
		runtime,
		evm,
		registry,
		REGISTRY_ABI,
		"sealOf",
		[eventId],
	) as [Address, bigint, { decimals: number; announcesAt: bigint; terms: Hex }];
	const state = call(runtime, evm, resolver, RESOLVER_ABI, "eventOf", [
		eventId,
	]) as {
		round: number;
		pendingArbitration: boolean;
		rounds: readonly [{ proposer: Address }, { proposer: Address }];
	};
	return {
		sealer,
		trustedSealer,
		decimals: threshold.decimals,
		announcesAt: threshold.announcesAt,
		terms: threshold.terms,
		round: state.round,
		pendingArbitration: state.pendingArbitration,
		openProposer: state.rounds[state.round].proposer,
		firstProposer: state.rounds[0].proposer,
	};
}

/**
 * Has the network sign the report and the forwarder deliver it to the receiver; throws unless the
 * transaction succeeded and the receiver accepted it, so a failed proposal shows as a failed run.
 * @return The transaction hash.
 */
export function submit(
	runtime: Runtime<unknown>,
	evm: EVMClient,
	receiver: Address,
	report: Hex,
): Hex {
	const signed = runtime.report(prepareReportRequest(report)).result();
	const reply = evm
		.writeReport(runtime, {
			receiver,
			report: signed,
			gasConfig: { gasLimit: REPORT_GAS_LIMIT },
		})
		.result();
	if (reply.txStatus !== TxStatus.SUCCESS) {
		throw new Error(
			`the report was not delivered: ${reply.errorMessage || reply.txStatus}`,
		);
	}
	if (
		reply.receiverContractExecutionStatus !== undefined &&
		reply.receiverContractExecutionStatus !== 0
	) {
		throw new Error(
			`the receiver refused the report: status ${reply.receiverContractExecutionStatus}`,
		);
	}
	return bytesToHex(reply.txHash ?? new Uint8Array(32));
}
