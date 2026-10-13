/**
 * The resolver's follow-ups the keeper takes: the permissionless calls that move an event along once
 * its time comes, which anyone may make and nobody is paid to. Each is decided from the resolver's own
 * views, and simulated before it is sent, so a follow-up someone else already made is never sent.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { parseAbi } from "viem";
import type { LocalAccount } from "viem/accounts";

/** A follow-up an event can be due. */
export type FollowUp = "settle" | "release" | "expire";

/** An event as the resolver reports it, and the instants its views compute. */
export type EventView = {
	round: number;
	pendingArbitration: boolean;
	rounds: readonly [Round, Round];
	liveness: bigint;
	expiresAt: bigint;
	outcomeTimeout: bigint;
	contestTimeout: bigint;
};
type Round = {
	proposer: string;
	proposedAt: bigint;
	settled: boolean;
	disputer: string;
	ruled: boolean;
};

const NOBODY = "0x0000000000000000000000000000000000000000";

/** The follow-ups an event is due at `now`, by the resolver's rules. */
export function dueFollowUps(event: EventView, now: bigint): FollowUp[] {
	const due: FollowUp[] = [];
	const first = event.rounds[0];
	if (first.disputer !== NOBODY && !first.ruled && now >= event.contestTimeout)
		due.push("release");
	if (event.pendingArbitration) {
		if (now >= event.outcomeTimeout) due.push("expire");
		return due;
	}
	const open = event.rounds[event.round];
	if (open.settled) return due;
	if (open.proposer !== NOBODY) {
		if (now >= open.proposedAt + event.liveness) due.push("settle");
	} else if (now > event.expiresAt) {
		due.push("expire");
	}
	return due;
}

const RESOLVER = parseAbi([
	"function eventOf(bytes32 eventId) view returns ((uint8 round, bool pendingArbitration, (address proposer, uint256 proposedAt, bool invalid, bool settled, int256 figure, uint8 decimals, address disputer, bool ruled, uint64 ruledAt, string reason)[2] rounds, string outcomeReason))",
	"function LIVENESS() view returns (uint256)",
	"function expiresAt(bytes32 eventId) view returns (uint256)",
	"function outcomeTimeout(bytes32 eventId) view returns (uint256)",
	"function contestTimeout(bytes32 eventId) view returns (uint256)",
	"function settle(bytes32 eventId)",
	"function release(bytes32 eventId)",
	"function expire(bytes32 eventId)",
]);

/** Reads an event's view from the resolver, at a block if given. */
export async function readEvent(
	client: PublicClient,
	resolver: Address,
	eventId: Hex,
	blockNumber?: bigint,
): Promise<EventView> {
	const read = <T>(
		functionName:
			| "eventOf"
			| "LIVENESS"
			| "expiresAt"
			| "outcomeTimeout"
			| "contestTimeout",
		args: readonly unknown[] = [],
	) =>
		client.readContract({
			address: resolver,
			abi: RESOLVER,
			functionName,
			args,
			blockNumber,
		} as never) as Promise<T>;
	const state = await read<{
		round: number;
		pendingArbitration: boolean;
		rounds: readonly [Round, Round];
	}>("eventOf", [eventId]);
	return {
		round: state.round,
		pendingArbitration: state.pendingArbitration,
		rounds: state.rounds,
		liveness: await read<bigint>("LIVENESS"),
		expiresAt: await read<bigint>("expiresAt", [eventId]),
		outcomeTimeout: await read<bigint>("outcomeTimeout", [eventId]),
		contestTimeout: await read<bigint>("contestTimeout", [eventId]),
	};
}

/** Takes every follow-up an event is due, each simulated first; returns the ones sent. */
export async function takeFollowUps(
	client: PublicClient,
	wallet: WalletClient,
	owner: LocalAccount,
	resolver: Address,
	eventId: Hex,
): Promise<FollowUp[]> {
	const now = (await client.getBlock()).timestamp;
	const sent: FollowUp[] = [];
	for (const followUp of dueFollowUps(
		await readEvent(client, resolver, eventId),
		now,
	)) {
		try {
			const { request } = await client.simulateContract({
				account: owner,
				address: resolver,
				abi: RESOLVER,
				functionName: followUp,
				args: [eventId],
			});
			const hash = await wallet.writeContract({
				...request,
				account: owner,
				chain: null,
			});
			await client.waitForTransactionReceipt({ hash });
			sent.push(followUp);
		} catch {
			// Someone made it first, or it is no longer due: the resolver refused it in simulation.
		}
	}
	return sent;
}
