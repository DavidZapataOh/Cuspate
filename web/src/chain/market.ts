/**
 * What the ticket reads from the chain: a quote from the network's quoter for exactly the pool the
 * router will trade in, the room a market has left, a wallet's dollars, and a check of the whole
 * purchase, approval included, before anything is signed. A refusal comes back as a problem in
 * plain words rather than as an error.
 */
import {
	type Address,
	BaseError,
	createPublicClient,
	type Hex,
	http,
	type PublicClient,
	parseAbi,
	parseAbiItem,
} from "viem";
import type { MarketBinding } from "../data/model.ts";
import type { Call } from "../ticket/order.ts";
import { type Problem, problemOf } from "../ticket/problems.ts";
import { worldPool } from "./pools.ts";
import { contracts, TESTNET } from "./record.ts";

const abi = {
	quoter: parseAbi([
		"function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
	]),
	erc20: parseAbi([
		"function balanceOf(address) view returns (uint256)",
		"function allowance(address owner, address spender) view returns (uint256)",
		"function totalSupply() view returns (uint256)",
	]),
	faucet: parseAbi([
		"function lastDrip(address) view returns (uint256)",
		"function COOLDOWN() view returns (uint256)",
	]),
	vault: parseAbi([
		"function CAP() view returns (uint256)",
		"function YES() view returns (address)",
	]),
};

/** A client reading the test network through an endpoint. */
export function chainClient(rpcUrl: string): PublicClient {
	return createPublicClient({ chain: TESTNET, transport: http(rpcUrl) });
}

/** The revert data an error carries, wherever in its causes it sits. */
export function revertData(error: unknown): Hex | undefined {
	if (!(error instanceof BaseError)) return undefined;
	const found = error.walk(
		(e) =>
			typeof (e as { data?: unknown }).data === "string" ||
			typeof (e as { raw?: unknown }).raw === "string",
	) as { data?: unknown; raw?: unknown } | null;
	const data = found?.raw ?? found?.data;
	return typeof data === "string" ? (data as Hex) : undefined;
}

/**
 * The largest amount, in the dollar's units and to a whole dollar, that a quote accepts: a binary
 * search between nothing and `upTo` over whether each amount is quoted.
 */
export async function largestQuoted(
	quotes: (dollars: bigint) => Promise<boolean>,
	upTo: bigint,
	unit = 1_000_000n,
): Promise<bigint> {
	let low = 0n;
	let high = upTo / unit;
	while (low < high) {
		const mid = (low + high + 1n) / 2n;
		if (await quotes(mid * unit)) low = mid;
		else high = mid - 1n;
	}
	return low * unit;
}

/** How many shares an amount of dollars buys in one world now, or why it cannot. */
export async function quoteShares(
	client: PublicClient,
	legs: MarketBinding["legs"],
	yes: boolean,
	dollars: bigint,
): Promise<{ shares: bigint } | { problem: Problem }> {
	const { key, zeroForOne } = worldPool(legs, yes, contracts.hook);
	try {
		const { result } = await client.simulateContract({
			address: contracts.quoter,
			abi: abi.quoter,
			functionName: "quoteExactInputSingle",
			args: [
				{ poolKey: key, zeroForOne, exactAmount: dollars, hookData: "0x" },
			],
		});
		return { shares: result[0] };
	} catch (error) {
		const problem = problemOf(revertData(error));
		if (problem.kind !== "depth" || problem.maxCents !== undefined)
			return { problem };
		// The pool cannot take it all: find how much it takes now, so the ticket can say so.
		const most = await largestQuoted(
			async (amount) =>
				"shares" in (await quoteOnce(client, key, zeroForOne, amount)),
			dollars,
		);
		return { problem: { kind: "depth", maxCents: most / 10_000n } };
	}
}

async function quoteOnce(
	client: PublicClient,
	key: ReturnType<typeof worldPool>["key"],
	zeroForOne: boolean,
	dollars: bigint,
): Promise<{ shares: bigint } | { failed: true }> {
	try {
		const { result } = await client.simulateContract({
			address: contracts.quoter,
			abi: abi.quoter,
			functionName: "quoteExactInputSingle",
			args: [
				{ poolKey: key, zeroForOne, exactAmount: dollars, hookData: "0x" },
			],
		});
		return { shares: result[0] };
	} catch {
		return { failed: true };
	}
}

/** How many more dollars, in cents, a market's dollar vault takes before it is full. */
export async function roomCents(
	client: PublicClient,
	dollarVault: Address,
): Promise<bigint> {
	const [cap, yes] = await Promise.all([
		client.readContract({
			address: dollarVault,
			abi: abi.vault,
			functionName: "CAP",
		}),
		client.readContract({
			address: dollarVault,
			abi: abi.vault,
			functionName: "YES",
		}),
	]);
	const outstanding = await client.readContract({
		address: yes,
		abi: abi.erc20,
		functionName: "totalSupply",
	});
	return (cap - outstanding) / 10_000n;
}

/** A wallet's test dollars and what it already allows the router to take, in the dollar's units. */
export async function fundsOf(client: PublicClient, owner: Address) {
	const [balance, allowance] = await Promise.all([
		client.readContract({
			address: contracts.dollar,
			abi: abi.erc20,
			functionName: "balanceOf",
			args: [owner],
		}),
		client.readContract({
			address: contracts.dollar,
			abi: abi.erc20,
			functionName: "allowance",
			args: [owner, contracts.router],
		}),
	]);
	return { balance, allowance };
}

/**
 * Runs a purchase's calls together against the current state, as its sender, without sending them:
 * nothing the chain would refuse is ever put in front of the buyer to sign.
 * @returns nothing when every call would succeed; otherwise the first refusal, in plain words.
 */
export async function checkPurchase(
	client: PublicClient,
	account: Address,
	calls: Call[],
): Promise<Problem | undefined> {
	try {
		const { results } = await client.simulateCalls({ account, calls });
		const failed = results.find((r) => r.status !== "success");
		if (!failed) return undefined;
		return problemOf(
			(failed as { error?: unknown; data?: Hex }).data ??
				revertData((failed as { error?: unknown }).error),
		);
	} catch (error) {
		return problemOf(revertData(error));
	}
}

const ENTERED = parseAbiItem(
	"event Entered(bytes32 indexed marketId, address indexed payer, address indexed recipient, bool yes, uint256 dollars, uint256 shares)",
);

/** The widest block range the network's endpoint serves logs for in one request. */
const LOG_RANGE = 100n;

/**
 * The shares a purchase actually bought, from the router's own record of it: the last entry into a
 * market for a recipient logged since a block. Nothing if none is found.
 */
export async function receivedShares(
	client: PublicClient,
	marketId: Hex,
	recipient: Address,
	fromBlock: bigint,
): Promise<bigint | undefined> {
	const latest = await client.getBlockNumber();
	let found: bigint | undefined;
	for (let a = fromBlock; a <= latest; a += LOG_RANGE) {
		const b = a + LOG_RANGE - 1n;
		const logs = await client.getLogs({
			address: contracts.router,
			event: ENTERED,
			args: { marketId, recipient },
			fromBlock: a,
			toBlock: b > latest ? latest : b,
		});
		const last = logs.at(-1);
		if (last?.args.shares !== undefined) found = last.args.shares;
	}
	return found;
}

/** When an address may next take test dollars, in seconds; 0 when it may now or never took any. */
export async function nextDripAt(
	client: PublicClient,
	owner: Address,
): Promise<number> {
	const [last, cooldown] = await Promise.all([
		client.readContract({
			address: contracts.dollar,
			abi: abi.faucet,
			functionName: "lastDrip",
			args: [owner],
		}),
		client.readContract({
			address: contracts.dollar,
			abi: abi.faucet,
			functionName: "COOLDOWN",
		}),
	]);
	return last === 0n ? 0 : Number(last + cooldown);
}
