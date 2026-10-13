/**
 * Reads what the watchers judge, every value at one block, and runs them. The block is the chain's
 * finalized one in production, since newer blocks are speculative and an alert on a block that is
 * then replaced would be noise.
 */
import {
	type Address,
	type BlockTag,
	type Hex,
	type PublicClient,
	parseAbi,
} from "viem";
import { ERC20, HOOK, VAULT } from "./abis.ts";
import { readEvent } from "./followups.ts";
import { type Deployment, type Market, poolId, readQuote } from "./market.ts";
import {
	type Alert,
	capWatcher,
	clockWatcher,
	freezeWatcher,
	oracleWatcher,
	solvencyWatcher,
} from "./watchers.ts";

const OUTCOMES = parseAbi([
	"function outcomeOf(bytes32 condition) view returns (uint8)",
	"function CONDITION() view returns (bytes32)",
]);
const HOOK_REGISTRY = parseAbi(["function REGISTRY() view returns (address)"]);
const REGISTRY = parseAbi([
	"function thresholdOf(bytes32 eventId) view returns (address sealer, uint256 sealBlock, int256 value, uint8 decimals, uint64 announcesAt, uint64 deadline)",
]);

/** How long a follow-up may stay due before its clock warns: two minutes past the keeper's interval. */
export const graceFor = (intervalSeconds: number) =>
	BigInt(intervalSeconds) + 120n;

/** Every alert the market raises at `blockTag`. */
export async function watch(
	client: PublicClient,
	deployment: Deployment & { resolver: Address },
	market: Market,
	eventId: Hex,
	grace: bigint,
	blockTag: BlockTag = "finalized",
): Promise<Alert[]> {
	const block = await client.getBlock({ blockTag });
	if (block.number === null)
		throw new Error(`the ${blockTag} block has no number`);
	const at = { blockNumber: block.number };
	const alerts: Alert[] = [];
	for (const [vault, collateral, yes, no] of [
		[
			market.underlyingVault,
			market.underlying,
			market.legs.underlyingYes,
			market.legs.underlyingNo,
		],
		[
			market.dollarVault,
			market.dollar,
			market.legs.dollarYes,
			market.legs.dollarNo,
		],
	] as const) {
		const balance = await client.readContract({
			...at,
			address: collateral,
			abi: ERC20,
			functionName: "balanceOf",
			args: [vault],
		});
		const yesSupply = await client.readContract({
			...at,
			address: yes,
			abi: ERC20,
			functionName: "totalSupply",
		});
		const noSupply = await client.readContract({
			...at,
			address: no,
			abi: ERC20,
			functionName: "totalSupply",
		});
		const cap = await client.readContract({
			...at,
			address: vault,
			abi: VAULT,
			functionName: "CAP",
		});
		const condition = await client.readContract({
			...at,
			address: vault,
			abi: OUTCOMES,
			functionName: "CONDITION",
		});
		const outcome = await client.readContract({
			...at,
			address: deployment.factory,
			abi: OUTCOMES,
			functionName: "outcomeOf",
			args: [condition],
		});
		alerts.push(
			...solvencyWatcher({ vault, balance, yesSupply, noSupply, outcome }),
		);
		if (outcome === 0) alerts.push(...capWatcher({ vault, cap, yesSupply }));
	}
	alerts.push(
		...oracleWatcher(
			await readQuote(client, deployment, block.number),
			block.timestamp,
		),
	);
	alerts.push(
		...clockWatcher(
			eventId,
			await readEvent(client, deployment.resolver, eventId, block.number),
			block.timestamp,
			grace,
		),
	);
	const registry = await client.readContract({
		...at,
		address: deployment.hook,
		abi: HOOK_REGISTRY,
		functionName: "REGISTRY",
	});
	const [, , , , announcesAt] = await client.readContract({
		...at,
		address: registry,
		abi: REGISTRY,
		functionName: "thresholdOf",
		args: [eventId],
	});
	const freezesAt = await client.readContract({
		...at,
		address: deployment.hook,
		abi: HOOK,
		functionName: "freezesAt",
		args: [poolId(market.yesKey)],
	});
	alerts.push(
		...freezeWatcher({
			market: market.marketId,
			freezesAt: BigInt(freezesAt),
			announcesAt: BigInt(announcesAt),
		}),
	);
	return alerts;
}

/** The sink alerts go to until an alert channel exists: one line of JSON each, on standard output. */
export function logAlerts(alerts: Alert[]) {
	for (const alert of alerts)
		console.log(JSON.stringify({ at: new Date().toISOString(), alert }));
}
