/**
 * What opening a batch of markets costs in MON, and the refusal to start one that the accounts paying
 * for it cannot finish. Monad charges the gas limit, not the gas used, so every figure here is limits.
 */
import { formatEther } from "viem";

/** What each account holds, in wei. */
export type Balances = { deployer: bigint; publisher: bigint; keeper: bigint };
/** What the next stretch needs, in wei: the batch itself, and a week of the two services. */
export type Needs = {
	batch: bigint;
	publisherWeek: bigint;
	keeperWeek: bigint;
};

/** Why the batch must not start, or null when every account covers its part. */
export function refuseBudget(held: Balances, needs: Needs): string | null {
	const reserve = needs.batch + needs.batch / 5n;
	if (held.deployer < reserve)
		return `refusing: the deployer holds ${formatEther(held.deployer)} MON, below the batch's ${formatEther(needs.batch)} MON plus a fifth`;
	if (held.publisher < needs.publisherWeek)
		return `refusing: the publisher holds ${formatEther(held.publisher)} MON, below a week of posting, ${formatEther(needs.publisherWeek)} MON`;
	if (held.keeper < needs.keeperWeek)
		return `refusing: the keeper holds ${formatEther(held.keeper)} MON, below a week of keeping, ${formatEther(needs.keeperWeek)} MON`;
	return null;
}

/** Gas limits summed by kind of step. */
export function tally(
	sent: { kind: string; gasLimit: bigint }[],
): Record<string, bigint> {
	const out: Record<string, bigint> = {};
	for (const s of sent) out[s.kind] = (out[s.kind] ?? 0n) + s.gasLimit;
	return out;
}
