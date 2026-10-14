/**
 * What the portfolio reads from the chain for one address: each recorded market's legs held, when
 * its pools freeze and the outcome its vaults read; and, for an undo, what the share sells for now.
 * Works from any client, so the server renders the portfolio and the browser re-quotes before an
 * undo is signed.
 */
import {
	type Address,
	encodeAbiParameters,
	keccak256,
	type PublicClient,
	parseAbi,
} from "viem";
import { type PoolKey, poolKeyOf, worldPool } from "../chain/pools.ts";
import { contracts } from "../chain/record.ts";
import type { MarketBinding } from "../data/model.ts";
import { OUTCOMES, type Position, worldOf } from "./position.ts";

const abi = {
	erc20: parseAbi(["function balanceOf(address) view returns (uint256)"]),
	factory: parseAbi([
		"function markets(bytes32) view returns (address underlyingVault, address dollarVault)",
	]),
	vault: parseAbi([
		"function OUTCOMES() view returns (address)",
		"function CONDITION() view returns (bytes32)",
	]),
	outcomes: parseAbi(["function outcomeOf(bytes32) view returns (uint8)"]),
	hook: parseAbi(["function freezesAt(bytes32) view returns (uint64)"]),
	quoter: parseAbi([
		"function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
	]),
};

/** A pool's id, as the pool manager derives it from its key. */
export function poolIdOf(key: PoolKey): `0x${string}` {
	return keccak256(
		encodeAbiParameters(
			[
				{ type: "address" },
				{ type: "address" },
				{ type: "uint24" },
				{ type: "int24" },
				{ type: "address" },
			],
			[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
		),
	);
}

/** A recorded market and the names the portfolio shows it under. */
export type Listed = {
	eventKey: string;
	conditionKey: string;
	issuer: string;
	market: MarketBinding;
};

/** One market's position for an address, or nothing when it holds none of its legs. */
async function positionIn(
	client: PublicClient,
	owner: Address,
	listed: Listed,
): Promise<Position> {
	const { market } = listed;
	const balance = (token: Address) =>
		({
			address: token,
			abi: abi.erc20,
			functionName: "balanceOf",
			args: [owner],
		}) as const;
	// Each round is one request through the network's multicall: the public endpoint limits bursts.
	const [underlyingYes, underlyingNo, dollarYes, dollarNo, vaults] =
		await client.multicall({
			allowFailure: false,
			contracts: [
				balance(market.legs.underlyingYes),
				balance(market.legs.underlyingNo),
				balance(market.legs.dollarYes),
				balance(market.legs.dollarNo),
				{
					address: contracts.factory,
					abi: abi.factory,
					functionName: "markets",
					args: [market.marketId],
				},
			],
		});
	const [outcomes, condition, freezesAt] = await client.multicall({
		allowFailure: false,
		contracts: [
			{
				address: market.dollarVault,
				abi: abi.vault,
				functionName: "OUTCOMES",
			},
			{
				address: market.dollarVault,
				abi: abi.vault,
				functionName: "CONDITION",
			},
			{
				address: contracts.hook,
				abi: abi.hook,
				functionName: "freezesAt",
				args: [
					poolIdOf(
						poolKeyOf(
							market.legs.dollarYes,
							market.legs.underlyingYes,
							contracts.hook,
						),
					),
				],
			},
		],
	});
	const outcome = await client.readContract({
		address: outcomes,
		abi: abi.outcomes,
		functionName: "outcomeOf",
		args: [condition],
	});
	return {
		eventKey: listed.eventKey,
		conditionKey: listed.conditionKey,
		issuer: listed.issuer,
		holder: owner,
		marketId: market.marketId,
		underlyingVault: vaults[0],
		dollarVault: market.dollarVault,
		legs: market.legs,
		holdings: { underlyingYes, underlyingNo, dollarYes, dollarNo },
		freezesAt: Number(freezesAt),
		outcome: OUTCOMES[outcome] ?? "unresolved",
	};
}

/**
 * Every recorded market's position for an address, holdings of nothing included. Markets are read
 * one after another, each again after a pause if it fails: the public endpoint limits its rate.
 */
export async function positionsOf(
	client: PublicClient,
	owner: Address,
	listed: Listed[],
): Promise<Position[]> {
	const positions: Position[] = [];
	for (const l of listed)
		positions.push(await patiently(() => positionIn(client, owner, l)));
	return positions;
}

/** Runs a read again after a pause when it fails, as the public endpoint does past its rate. */
async function patiently<T>(read: () => Promise<T>, tries = 5): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await read();
		} catch (error) {
			if (attempt >= tries) throw error;
			await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
		}
	}
}

/**
 * What a position's share sells for now in its world's pool, in that world's dollar.
 * @returns nothing when the pool refuses the sale, as a frozen one does.
 */
export async function quoteUndo(
	client: PublicClient,
	position: Position,
): Promise<bigint | undefined> {
	const yes = worldOf(position.holdings);
	const shares = yes
		? position.holdings.underlyingYes
		: position.holdings.underlyingNo;
	if (shares === 0n) return undefined;
	const { key, zeroForOne } = worldPool(position.legs, yes, contracts.hook);
	try {
		const { result } = await client.simulateContract({
			address: contracts.quoter,
			abi: abi.quoter,
			functionName: "quoteExactInputSingle",
			// The purchase sells the dollar for the share; an undo sells the share back.
			args: [
				{
					poolKey: key,
					zeroForOne: !zeroForOne,
					exactAmount: shares,
					hookData: "0x",
				},
			],
		});
		return result[0];
	} catch {
		return undefined;
	}
}
