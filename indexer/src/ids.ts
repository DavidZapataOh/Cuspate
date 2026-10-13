import { encodeAbiParameters, getContractAddress, keccak256 } from "viem";

/** An address as the indexer keys it: lower case, whatever case the source wrote it in. */
export const key = (address: string): string => address.toLowerCase();

/** An id for one log: its block and its index in the block. */
export const logId = (event: {
	block: { number: number };
	logIndex: number;
}): string => `${event.block.number}-${event.logIndex}`;

/** A holder's balance of one leg. */
export const balanceId = (leg: string, holder: string): string =>
	`${key(leg)}-${key(holder)}`;

/** One round of an event's resolution. */
export const proposalId = (eventId: string, round: number): string =>
	`${eventId}-${round}`;

/**
 * A vault's two legs. No event names them: the vault creates them in its constructor, YES first, so
 * they are its first two contract creations, at nonces 1 and 2.
 */
export function legsOf(vault: string): { yes: string; no: string } {
	const at = (nonce: bigint) =>
		key(getContractAddress({ from: vault as `0x${string}`, nonce }));
	return { yes: at(1n), no: at(2n) };
}

/** The condition a resolver reports an event's outcome under, as the factory derives it. */
export function conditionOf(resolver: string, eventId: string): string {
	return keccak256(
		encodeAbiParameters(
			[{ type: "address" }, { type: "bytes32" }],
			[resolver as `0x${string}`, eventId as `0x${string}`],
		),
	);
}
