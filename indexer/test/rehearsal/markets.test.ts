/**
 * The indexer reproduces a markets rehearsal: on the fork a markets run opened its markets on, the
 * blocks it wrote are indexed with the network's generated configuration, and every market, leg and
 * pool is compared with what the contracts answer. Run by the markets rehearsal, never by the suite.
 */
import { readFileSync } from "node:fs";
import { createTestIndexer } from "envio";
import {
	type Address,
	createPublicClient,
	type Hex,
	http,
	parseAbi,
} from "viem";
import { beforeAll, describe, expect, test } from "vitest";
import { FORK_REQUEST_TIMEOUT_MS } from "../harness/fork";

const url = process.env.REHEARSAL_RPC_URL;
const bookFile = process.env.REHEARSAL_BOOK;
const chainId = Number(process.env.REHEARSAL_CHAIN);
const startBlock = Number(process.env.REHEARSAL_START_BLOCK);
const endBlock = Number(process.env.REHEARSAL_END_BLOCK);
const ERC20 = parseAbi(["function totalSupply() view returns (uint256)"]);
const STATE_VIEW = parseAbi([
	"function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
	"function getLiquidity(bytes32) view returns (uint128)",
]);

type Recorded = {
	marketId: Hex;
	eventId: Hex;
	underlyingVault: Address;
	dollarVault: Address;
	legs: Record<string, Address>;
};

let book: {
	markets: Record<string, Recorded>;
	thirdParty: Record<string, Address[]>;
};
let indexed: ReturnType<typeof createTestIndexer>;
const lower = (value: string) => value.toLowerCase();

beforeAll(async () => {
	if (!url || !bookFile || !chainId || !startBlock || !endBlock)
		throw new Error(
			"the reconciliation runs on a markets rehearsal, which sets its REHEARSAL_ variables",
		);
	book = JSON.parse(readFileSync(bookFile, "utf8"));
	indexed = createTestIndexer();
	await indexed.process({
		chains: { [chainId]: { startBlock, endBlock } },
	} as never);
}, 600_000);

describe("the indexer, against a markets rehearsal", () => {
	const client = () =>
		createPublicClient({
			transport: http(url, { timeout: FORK_REQUEST_TIMEOUT_MS }),
		});

	test("finds every market the run recorded, and no other", async () => {
		const markets = await indexed.Market.getAll();
		const recorded = Object.values(book.markets);
		expect(markets.map((m) => m.id).sort()).toEqual(
			recorded.map((m) => m.marketId).sort(),
		);
		for (const market of recorded) {
			const found = markets.find((m) => m.id === market.marketId);
			expect(found?.eventId).toBe(market.eventId);
			expect(found?.underlyingVault).toBe(lower(market.underlyingVault));
			expect(found?.dollarVault).toBe(lower(market.dollarVault));
		}
	});

	test("every leg's supply is the chain's", async () => {
		const legs = await indexed.Leg.getAll();
		expect(legs.length).toBe(4 * Object.keys(book.markets).length);
		for (const leg of legs)
			expect([leg.id, leg.supply]).toEqual([
				leg.id,
				await client().readContract({
					address: leg.id as Address,
					abi: ERC20,
					functionName: "totalSupply",
				}),
			]);
	});

	test("every pool's price, tick and liquidity are the chain's", async () => {
		const pools = await indexed.Pool.getAll();
		expect(pools.length).toBe(3 * Object.keys(book.markets).length);
		const stateView = book.thirdParty.stateView?.[0] as Address;
		for (const pool of pools) {
			const [sqrtPriceX96, tick] = await client().readContract({
				address: stateView,
				abi: STATE_VIEW,
				functionName: "getSlot0",
				args: [pool.id as Hex],
			});
			const liquidity = await client().readContract({
				address: stateView,
				abi: STATE_VIEW,
				functionName: "getLiquidity",
				args: [pool.id as Hex],
			});
			expect({
				id: pool.id,
				sqrtPriceX96: pool.sqrtPriceX96,
				tick: pool.tick,
				liquidity: pool.liquidity,
				initialized: pool.initialized,
			}).toEqual({
				id: pool.id,
				sqrtPriceX96,
				tick,
				liquidity,
				initialized: true,
			});
		}
	});
});
