/**
 * A market as the keeper reads it: its vaults and legs, its three pools in their token order, their
 * prices, the feed's quote, the freeze, and each vault's room.
 */
import {
	type Address,
	encodeAbiParameters,
	type Hex,
	keccak256,
	type PublicClient,
} from "viem";
import { ERC20, FACTORY, HOOK, ORACLE, STATE_VIEW, VAULT } from "./abis.ts";
import {
	impliedPrice,
	probability,
	type Quote,
	worldPrice,
} from "./arithmetic.ts";

/** The feed's id for a symbol: the hash of its ticker. */
export const priceIdOf = (symbol: string): Hex =>
	keccak256(new TextEncoder().encode(symbol));

/** The feed's id for the market the keeper was first written for. */
export const MU: Hex = priceIdOf("MU");

/** A pool's key, as the protocol derives it: the pair in address order, its fee and spacing, the hook. */
export type PoolKey = {
	currency0: Address;
	currency1: Address;
	fee: number;
	tickSpacing: number;
	hooks: Address;
};

export function poolKey(a: Address, b: Address, hooks: Address): PoolKey {
	const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
	return { currency0, currency1, fee: 3000, tickSpacing: 60, hooks };
}

export function poolId(key: PoolKey): Hex {
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

/** Where the keeper finds a market and what it trades through. */
export type Deployment = {
	factory: Address;
	hook: Address;
	router: Address;
	stateView: Address;
	quoter: Address;
	oracle: Address;
	permit2: Address;
	universalRouter: Address;
};

/** A market's fixed shape, read once. */
export type Market = Awaited<ReturnType<typeof readMarket>>;

export async function readMarket(
	client: PublicClient,
	deployment: Deployment,
	marketId: Hex,
	priceId: Hex = MU,
) {
	const [underlyingVault, dollarVault] = await client.readContract({
		address: deployment.factory,
		abi: FACTORY,
		functionName: "markets",
		args: [marketId],
	});
	const leg = (vault: Address, side: "YES" | "NO") =>
		client.readContract({ address: vault, abi: VAULT, functionName: side });
	const legs = {
		underlyingYes: await leg(underlyingVault, "YES"),
		underlyingNo: await leg(underlyingVault, "NO"),
		dollarYes: await leg(dollarVault, "YES"),
		dollarNo: await leg(dollarVault, "NO"),
	};
	const yesKey = poolKey(legs.underlyingYes, legs.dollarYes, deployment.hook);
	const noKey = poolKey(legs.underlyingNo, legs.dollarNo, deployment.hook);
	const probabilityKey = poolKey(
		legs.dollarYes,
		legs.dollarNo,
		deployment.hook,
	);
	return {
		marketId,
		priceId,
		underlyingVault,
		dollarVault,
		underlying: await client.readContract({
			address: underlyingVault,
			abi: VAULT,
			functionName: "COLLATERAL",
		}),
		dollar: await client.readContract({
			address: dollarVault,
			abi: VAULT,
			functionName: "COLLATERAL",
		}),
		legs,
		yesKey,
		noKey,
		probabilityKey,
	};
}

/** The implied price now, 18 decimals, from the three pools' spot prices. */
export async function readImplied(
	client: PublicClient,
	deployment: Deployment,
	market: Market,
): Promise<bigint> {
	const sqrtOf = async (key: PoolKey) =>
		(
			await client.readContract({
				address: deployment.stateView,
				abi: STATE_VIEW,
				functionName: "getSlot0",
				args: [poolId(key)],
			})
		)[0];
	const p = probability(
		await sqrtOf(market.probabilityKey),
		market.probabilityKey.currency0 === market.legs.dollarYes,
	);
	const yes = worldPrice(
		await sqrtOf(market.yesKey),
		market.yesKey.currency0 === market.legs.underlyingYes,
	);
	const no = worldPrice(
		await sqrtOf(market.noKey),
		market.noKey.currency0 === market.legs.underlyingNo,
	);
	return impliedPrice(p, yes, no);
}

/** The feed's latest round for the market's underlying, at a block if given. */
export async function readQuote(
	client: PublicClient,
	deployment: Deployment,
	market: Pick<Market, "priceId">,
	blockNumber?: bigint,
): Promise<Quote> {
	const [price, bid, ask, , publishedAt, , session] = await client.readContract(
		{
			address: deployment.oracle,
			abi: ORACLE,
			functionName: "latestPrice",
			args: [market.priceId],
			blockNumber,
		},
	);
	return { price, bid, ask, publishedAt, session };
}

/** When the market's pools freeze. */
export async function readFreeze(
	client: PublicClient,
	deployment: Deployment,
	market: Market,
): Promise<bigint> {
	return BigInt(
		await client.readContract({
			address: deployment.hook,
			abi: HOOK,
			functionName: "freezesAt",
			args: [poolId(market.yesKey)],
		}),
	);
}

/** How much more collateral a vault accepts. */
export async function readRoom(
	client: PublicClient,
	vault: Address,
	yesLeg: Address,
): Promise<bigint> {
	const cap = await client.readContract({
		address: vault,
		abi: VAULT,
		functionName: "CAP",
	});
	const supply = await client.readContract({
		address: yesLeg,
		abi: ERC20,
		functionName: "totalSupply",
	});
	return cap - supply;
}
