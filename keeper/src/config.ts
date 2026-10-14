/**
 * The keeper's settings, from the environment. The protocol's addresses are the deployment's; the
 * third parties it trades through are its chain's, from the repository's address book. On the test
 * network the feed it reads is the test network's own, which mirrors the production one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, keccak256, toBytes } from "viem";
import type { Deployment } from "./market.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SYMBOL = /^[A-Z][A-Z.]{0,9}$/;
/** The chains the keeper runs on: the production chain and the public test network. */
const CHAINS = ["143", "10143"];
/**
 * Whether each chain's Universal Router takes `minHopPriceX36` in a single-pool swap: the test
 * network's runs a later v4-periphery release than the production chain's. A fork test on each chain
 * holds the entry to what its router decodes.
 */
export const ROUTER_MIN_HOP_PRICE: Record<string, boolean> = {
	"143": false,
	"10143": true,
};

const deployments = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../contracts/deployments",
);

/** One market the keeper keeps in band, and the feed id its underlying is priced by. */
export type KeptMarket = { marketId: Hex; eventId: Hex; priceId: Hex };

export type Config = ReturnType<typeof configFromEnv>;

export function configFromEnv(env: Record<string, string | undefined>) {
	const get = (name: string, pattern?: RegExp) => {
		const value = env[name];
		if (value === undefined || value === "")
			throw new Error(`${name} is not set`);
		if (pattern && !pattern.test(value))
			throw new Error(`${name} is malformed`);
		return value;
	};
	const positive = (name: string, fallback: string) => {
		const value = env[name] ?? fallback;
		if (!/^\d+$/.test(value) || BigInt(value) === 0n)
			throw new Error(`${name} must be a positive integer`);
		return BigInt(value);
	};
	const chain = env.KEEPER_CHAIN ?? "143";
	if (!CHAINS.includes(chain))
		throw new Error(`KEEPER_CHAIN must be one of ${CHAINS.join(", ")}`);
	const book = JSON.parse(
		readFileSync(path.join(deployments, `${chain}.json`), "utf8"),
	) as {
		thirdParty: Record<string, Address[]>;
		TestnetStockOracle?: { address: Address };
	};
	const thirdParty = book.thirdParty;
	const oracle =
		thirdParty.stockOracle?.[0] ?? book.TestnetStockOracle?.address;
	if (!oracle) throw new Error(`chain ${chain} records no price feed`);
	const deployment: Deployment = {
		factory: get("CUSPATE_MARKET_FACTORY", ADDRESS) as Address,
		hook: get("CUSPATE_FREEZE_HOOK", ADDRESS) as Address,
		router: get("CUSPATE_POSITION_ROUTER", ADDRESS) as Address,
		stateView: thirdParty.stateView[0],
		quoter: thirdParty.v4Quoter[0],
		oracle,
		permit2: thirdParty.permit2[0],
		universalRouter: thirdParty.universalRouter[0],
		universalRouterMinHopPrice: ROUTER_MIN_HOP_PRICE[chain],
	};
	const priceIdOf = (symbol: string, name: string) => {
		if (!SYMBOL.test(symbol)) throw new Error(`${name} is malformed`);
		return keccak256(toBytes(symbol));
	};
	let markets: KeptMarket[];
	if (env.KEEPER_MARKETS_FILE) {
		const file = JSON.parse(readFileSync(env.KEEPER_MARKETS_FILE, "utf8")) as {
			chainId: number;
			markets: { marketId: string; eventId: string; symbol: string }[];
		};
		if (String(file.chainId) !== chain)
			throw new Error(
				`KEEPER_CHAIN is ${chain} but KEEPER_MARKETS_FILE lists chain ${file.chainId}'s markets`,
			);
		markets = file.markets.map((m) => {
			if (!BYTES32.test(m.marketId) || !BYTES32.test(m.eventId))
				throw new Error("KEEPER_MARKETS_FILE lists a malformed id");
			return {
				marketId: m.marketId as Hex,
				eventId: m.eventId as Hex,
				priceId: priceIdOf(m.symbol, "KEEPER_MARKETS_FILE"),
			};
		});
		if (markets.length === 0)
			throw new Error("KEEPER_MARKETS_FILE lists no market");
	} else {
		markets = [
			{
				marketId: get("KEEPER_MARKET_ID", BYTES32) as Hex,
				eventId: get("KEEPER_EVENT_ID", BYTES32) as Hex,
				priceId: priceIdOf(get("KEEPER_SYMBOL"), "KEEPER_SYMBOL"),
			},
		];
	}
	return {
		chainId: Number(chain),
		rpcUrl: get("KEEPER_RPC_URL"),
		key: get("KEEPER_KEY", BYTES32) as Hex,
		safe: get("KEEPER_SAFE", ADDRESS) as Address,
		markets,
		resolver: get("CUSPATE_RESOLVER", ADDRESS) as Address,
		stateDir: get("KEEPER_STATE_DIR"),
		multiSend: thirdParty.safeMultiSendCallOnly[0],
		deployment,
		intervalSeconds: Number(positive("KEEPER_INTERVAL_SECONDS", "30")),
		clip: positive("KEEPER_CLIP", ((1n << 256n) - 1n).toString()),
	};
}
