/**
 * A correction of a market's implied price, sized and floored from quotes, and the batch that makes it
 * atomically. A port of the reference keeper's: the rich batch sells shares in both worlds and levels
 * the dollar leg left over; the cheap batch buys shares in both worlds, merges them, levels the dollar
 * leg left over through the Universal Router, and merges the dollars.
 */
import {
	type Address,
	encodeAbiParameters,
	encodeFunctionData,
	encodePacked,
	type Hex,
	type PublicClient,
} from "viem";
import {
	ERC20,
	PERMIT2,
	QUOTER,
	ROUTER,
	UNIVERSAL_ROUTER,
	VAULT,
} from "./abis.ts";
import type { Deployment, Market, PoolKey } from "./market.ts";

/** One call of a batch. */
export type Call = { to: Address; data: Hex };

/** A correction, its size and every floor, all from quotes on the state it runs on. */
export type Correction = {
	rich: boolean;
	shares: bigint;
	yesOut: bigint;
	noOut: bigint;
	level: bigint;
	levelOut: bigint;
};

/** An exact-input quote: what selling `amount` of `input` pays. */
export async function quoteIn(
	client: PublicClient,
	deployment: Deployment,
	key: PoolKey,
	input: Address,
	amount: bigint,
) {
	if (amount === 0n) return 0n;
	const { result } = await client.simulateContract({
		address: deployment.quoter,
		abi: QUOTER,
		functionName: "quoteExactInputSingle",
		args: [
			{
				poolKey: key,
				zeroForOne: key.currency0 === input,
				exactAmount: amount,
				hookData: "0x",
			},
		],
	});
	return result[0];
}

/** An exact-output quote: what buying exactly `amount` of the other currency costs in `input`. */
export async function quoteOut(
	client: PublicClient,
	deployment: Deployment,
	key: PoolKey,
	input: Address,
	amount: bigint,
) {
	if (amount === 0n) return 0n;
	const { result } = await client.simulateContract({
		address: deployment.quoter,
		abi: QUOTER,
		functionName: "quoteExactOutputSingle",
		args: [
			{
				poolKey: key,
				zeroForOne: key.currency0 === input,
				exactAmount: amount,
				hookData: "0x",
			},
		],
	});
	return result[0];
}

/**
 * The largest amount of a surplus dollar leg whose sale leaves the two legs level, and what it pays:
 * equality is reached near `surplus / (1 + price)`, found by bisection.
 */
async function levelFor(
	client: PublicClient,
	deployment: Deployment,
	market: Market,
	surplus: bigint,
	sold: Address,
) {
	let low = 0n;
	let high = surplus;
	while (low < high) {
		const middle = (low + high + 1n) / 2n;
		if (
			surplus - middle >=
			(await quoteIn(client, deployment, market.probabilityKey, sold, middle))
		)
			low = middle;
		else high = middle - 1n;
	}
	return {
		level: low,
		levelOut:
			low === 0n
				? 0n
				: await quoteIn(client, deployment, market.probabilityKey, sold, low),
	};
}

/** A rich correction's amounts: the three pools are disjoint, so each sale and the level quote apart. */
export async function quoteRich(
	client: PublicClient,
	deployment: Deployment,
	market: Market,
	shares: bigint,
): Promise<Correction> {
	const yesOut = await quoteIn(
		client,
		deployment,
		market.yesKey,
		market.legs.underlyingYes,
		shares,
	);
	const noOut = await quoteIn(
		client,
		deployment,
		market.noKey,
		market.legs.underlyingNo,
		shares,
	);
	// The no world's exit keeps the yes-dollars; whichever leg is larger is levelled.
	const [surplus, sold] =
		yesOut > noOut
			? [yesOut - noOut, market.legs.dollarYes]
			: [noOut - yesOut, market.legs.dollarNo];
	return {
		rich: true,
		shares,
		yesOut,
		noOut,
		...(await levelFor(client, deployment, market, surplus, sold)),
	};
}

/** A cheap correction's amounts: the dollars that buy exactly `shares` in each world, and the level. */
export async function quoteCheap(
	client: PublicClient,
	deployment: Deployment,
	market: Market,
	shares: bigint,
): Promise<Correction> {
	const yesOut = await quoteOut(
		client,
		deployment,
		market.yesKey,
		market.legs.dollarYes,
		shares,
	);
	const noOut = await quoteOut(
		client,
		deployment,
		market.noKey,
		market.legs.dollarNo,
		shares,
	);
	// Entering the yes world keeps no-dollars, entering the no world keeps yes-dollars.
	const [surplus, sold] =
		yesOut > noOut
			? [yesOut - noOut, market.legs.dollarNo]
			: [noOut - yesOut, market.legs.dollarYes];
	return {
		rich: false,
		shares,
		yesOut,
		noOut,
		...(await levelFor(client, deployment, market, surplus, sold)),
	};
}

const call = (to: Address, data: Hex): Call => ({ to, data });
const approve = (token: Address, spender: Address, amount: bigint) =>
	call(
		token,
		encodeFunctionData({
			abi: ERC20,
			functionName: "approve",
			args: [spender, amount],
		}),
	);

function exitCall(
	deployment: Deployment,
	market: Market,
	account: Address,
	deadline: bigint,
	order: {
		yes: boolean;
		shares: bigint;
		kept: bigint;
		minOut: bigint;
		levelSellsWorldDollar: boolean;
		level: bigint;
		minLevelOut: bigint;
	},
): Call {
	return call(
		deployment.router,
		encodeFunctionData({
			abi: ROUTER,
			functionName: "exit",
			args: [
				{ marketId: market.marketId, recipient: account, deadline, ...order },
			],
		}),
	);
}

/** The rich batch: split, sell the yes shares, sell the no shares keeping the yes-dollars, level. */
export function richBatch(
	deployment: Deployment,
	market: Market,
	account: Address,
	c: Correction,
	deadline: bigint,
): Call[] {
	return [
		approve(market.underlying, market.underlyingVault, c.shares),
		call(
			market.underlyingVault,
			encodeFunctionData({
				abi: VAULT,
				functionName: "splitPosition",
				args: [c.shares],
			}),
		),
		approve(market.legs.underlyingYes, deployment.router, c.shares),
		exitCall(deployment, market, account, deadline, {
			yes: true,
			shares: c.shares,
			kept: 0n,
			minOut: c.yesOut,
			levelSellsWorldDollar: false,
			level: 0n,
			minLevelOut: 0n,
		}),
		approve(market.legs.underlyingNo, deployment.router, c.shares),
		approve(market.legs.dollarYes, deployment.router, c.yesOut),
		exitCall(deployment, market, account, deadline, {
			yes: false,
			shares: c.shares,
			kept: c.yesOut,
			minOut: c.noOut,
			levelSellsWorldDollar: c.noOut > c.yesOut,
			level: c.level,
			minLevelOut: c.levelOut,
		}),
	];
}

/** The Universal Router's single-pool exact-input swap of a dollar leg, settled and taken in full. */
function levelCall(
	deployment: Deployment,
	market: Market,
	sold: Address,
	amount: bigint,
	minOut: bigint,
	deadline: bigint,
): Call {
	const key = market.probabilityKey;
	const zeroForOne = key.currency0 === sold;
	const bought = zeroForOne ? key.currency1 : key.currency0;
	const swap = encodeAbiParameters(
		[
			{
				type: "tuple",
				components: [
					{
						name: "poolKey",
						type: "tuple",
						components: [
							{ name: "currency0", type: "address" },
							{ name: "currency1", type: "address" },
							{ name: "fee", type: "uint24" },
							{ name: "tickSpacing", type: "int24" },
							{ name: "hooks", type: "address" },
						],
					},
					{ name: "zeroForOne", type: "bool" },
					{ name: "amountIn", type: "uint128" },
					{ name: "amountOutMinimum", type: "uint128" },
					{ name: "hookData", type: "bytes" },
				],
			},
		],
		[
			{
				poolKey: key,
				zeroForOne,
				amountIn: amount,
				amountOutMinimum: minOut,
				hookData: "0x",
			},
		],
	);
	const settle = encodeAbiParameters(
		[{ type: "address" }, { type: "uint256" }],
		[sold, amount],
	);
	const take = encodeAbiParameters(
		[{ type: "address" }, { type: "uint256" }],
		[bought, minOut],
	);
	// SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL, under the V4_SWAP command.
	const input = encodeAbiParameters(
		[{ type: "bytes" }, { type: "bytes[]" }],
		[
			encodePacked(["uint8", "uint8", "uint8"], [0x06, 0x0c, 0x0f]),
			[swap, settle, take],
		],
	);
	return call(
		deployment.universalRouter,
		encodeFunctionData({
			abi: UNIVERSAL_ROUTER,
			functionName: "execute",
			args: ["0x10", [input], deadline],
		}),
	);
}

/** The cheap batch: buy shares in each world, merge them, level the leftover dollar leg, merge dollars. */
export function cheapBatch(
	deployment: Deployment,
	market: Market,
	account: Address,
	c: Correction,
	deadline: bigint,
): Call[] {
	const noDollarsLeft = c.yesOut > c.noOut;
	const sold = noDollarsLeft ? market.legs.dollarNo : market.legs.dollarYes;
	const levelled = noDollarsLeft ? c.noOut + c.levelOut : c.yesOut + c.levelOut;
	const enter = (yes: boolean, dollars: bigint) =>
		call(
			deployment.router,
			encodeFunctionData({
				abi: ROUTER,
				functionName: "enter",
				args: [market.marketId, yes, dollars, c.shares, account, deadline],
			}),
		);
	return [
		approve(market.dollar, deployment.router, c.yesOut + c.noOut),
		enter(true, c.yesOut),
		enter(false, c.noOut),
		call(
			market.underlyingVault,
			encodeFunctionData({
				abi: VAULT,
				functionName: "mergePositions",
				args: [c.shares],
			}),
		),
		approve(sold, deployment.permit2, c.level),
		call(
			deployment.permit2,
			encodeFunctionData({
				abi: PERMIT2,
				functionName: "approve",
				args: [sold, deployment.universalRouter, c.level, 2 ** 48 - 1],
			}),
		),
		levelCall(deployment, market, sold, c.level, c.levelOut, deadline),
		call(
			market.dollarVault,
			encodeFunctionData({
				abi: VAULT,
				functionName: "mergePositions",
				args: [levelled],
			}),
		),
	];
}
