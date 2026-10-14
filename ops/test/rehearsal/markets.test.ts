/**
 * The gate a markets broadcast requires: on the rehearsed fork, every market the run recorded is
 * checked against its receipts and the chain (sealed by the sealer's Safe with the rendered terms,
 * created as recorded, its three pools at their opening prices and frozen at the announcement, its
 * positions owned by the treasury's Safe), and a user who only has the faucet enters and exits one
 * through the router.
 */
import {
	type Address,
	encodeAbiParameters,
	type Hex,
	keccak256,
	maxUint256,
	parseAbi,
	parseEventLogs,
} from "viem";
import { beforeAll, describe, expect, test } from "vitest";
import { attachFork, type Fork } from "../../../indexer/test/harness/fork.ts";
import { artifact } from "../../src/artifacts.ts";
import { type Book, readBook } from "../../src/book.ts";
import { loadEvents, thresholdOf } from "../../src/events.ts";
import { FEE, TICK_SPACING } from "../../src/markets.ts";
import type { MarketRecord } from "../../src/open-markets.ts";

const url = process.env.REHEARSAL_RPC_URL;
const chainId = Number(process.env.REHEARSAL_CHAIN);
const bookFile = process.env.REHEARSAL_BOOK;
const ERC20 = parseAbi([
	"function approve(address, uint256) returns (bool)",
	"function balanceOf(address) view returns (uint256)",
]);
const STATE_VIEW = parseAbi([
	"function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const OWNERS = parseAbi([
	"function ownerOf(uint256 id) view returns (address)",
]);
const HOOK = parseAbi([
	"function freezesAt(bytes32 poolId) view returns (uint64)",
]);
/** Someone with nothing but the faucet. */
const USER = "0x00000000000000000000000000000000c05a7e01" as Address;

let fork: Fork;
let book: Book;
let markets: MarketRecord[];

function at(key: string): Address {
	const found = book[key] as { address: Address } | undefined;
	if (!found) throw new Error(`the rehearsal recorded no ${key}`);
	return found.address;
}

function third(key: string): Address {
	const address = book.thirdParty?.[key]?.[0];
	if (!address) throw new Error(`no third-party ${key}`);
	return address;
}

function poolId(pool: MarketRecord["pools"][number]): Hex {
	return keccak256(
		encodeAbiParameters(
			[
				{ type: "address" },
				{ type: "address" },
				{ type: "uint24" },
				{ type: "int24" },
				{ type: "address" },
			],
			[pool.currency0, pool.currency1, FEE, TICK_SPACING, at("FreezeHook")],
		),
	);
}

async function receipt(hash: Hex) {
	const found = await fork.client.getTransactionReceipt({ hash });
	expect(found.status).toBe("success");
	return found;
}

async function as(
	from: Address,
	to: Address,
	abi: Parameters<typeof parseEventLogs>[0]["abi"],
	functionName: string,
	args: readonly unknown[],
) {
	const wallet = await fork.as(from);
	const hash = await wallet.writeContract({
		address: to,
		abi,
		functionName,
		args,
		chain: null,
	} as never);
	const mined = await fork.client.waitForTransactionReceipt({ hash });
	expect(mined.status).toBe("success");
	return mined;
}

beforeAll(async () => {
	if (!url || !bookFile || !chainId)
		throw new Error(
			"the gate runs on a rehearsal: REHEARSAL_RPC_URL, REHEARSAL_CHAIN and REHEARSAL_BOOK",
		);
	fork = await attachFork(url, chainId);
	book = readBook(bookFile);
	markets = Object.values((book.markets ?? {}) as Record<string, MarketRecord>);
});

describe("the markets a run opened", () => {
	test("every condition of every event recorded is open", () => {
		expect(markets.length).toBeGreaterThan(0);
		const byEvent = new Map<string, number>();
		for (const market of markets)
			byEvent.set(market.eventKey, (byEvent.get(market.eventKey) ?? 0) + 1);
		for (const count of byEvent.values()) expect(count).toBe(4);
	});

	test("each was sealed by the sealer's Safe with the terms rendered for it", async () => {
		const manifest = loadEvents(chainId);
		const registry = {
			address: at("ThresholdRegistry"),
			abi: artifact("src/ThresholdRegistry.sol:ThresholdRegistry").abi,
		};
		for (const market of markets) {
			const event = manifest.events.find((e) => e.eventKey === market.eventKey);
			const condition = event?.conditions.find(
				(c) => c.key === market.condition,
			);
			if (!event || !condition)
				throw new Error(
					`${market.eventKey}/${market.condition} is not in the manifest`,
				);
			const [sealer, , sealed] = (await fork.client.readContract({
				...registry,
				functionName: "sealOf",
				args: [market.eventId],
			})) as [
				Address,
				bigint,
				{ value: bigint; terms: Hex; announcesAt: bigint },
			];
			expect(sealer.toLowerCase()).toBe(
				book.roles?.sealer?.address.toLowerCase(),
			);
			const expected = thresholdOf(event, condition);
			expect(sealed.value).toBe(expected.value);
			expect(sealed.announcesAt).toBe(expected.announcesAt);
			expect(sealed.terms.toLowerCase()).toBe(expected.terms.toLowerCase());
			if (market.sealTx) {
				const logs = parseEventLogs({
					abi: registry.abi,
					logs: (await receipt(market.sealTx)).logs,
					eventName: "ThresholdSealed",
				}) as unknown as { args: { eventId: Hex } }[];
				expect(logs.map((l) => l.args.eventId)).toContain(market.eventId);
			}
		}
	});

	test("each market is the one its creation receipt reports", async () => {
		const abi = artifact("src/MarketFactory.sol:MarketFactory").abi;
		for (const market of markets) {
			if (market.createTx === "0x") continue;
			const [log] = parseEventLogs({
				abi,
				logs: (await receipt(market.createTx)).logs,
				eventName: "MarketCreated",
			}) as unknown as {
				args: {
					marketId: Hex;
					eventId: Hex;
					underlyingVault: Address;
					dollarVault: Address;
					underlyingCap: bigint;
					dollarCap: bigint;
				};
			}[];
			expect(log?.args.marketId).toBe(market.marketId);
			expect(log?.args.eventId).toBe(market.eventId);
			expect(log?.args.underlyingVault).toBe(market.underlyingVault);
			expect(log?.args.dollarVault).toBe(market.dollarVault);
			expect(String(log?.args.underlyingCap)).toBe(market.shareCap);
			expect(String(log?.args.dollarCap)).toBe(market.dollarCap);
		}
	});

	test("its pools opened at their prices, freeze at the announcement, and the treasury owns the liquidity", async () => {
		const treasury = book.roles?.treasury?.address.toLowerCase();
		const manifest = loadEvents(chainId);
		for (const market of markets) {
			const announcesAt = BigInt(
				Date.parse(
					manifest.events.find((e) => e.eventKey === market.eventKey)
						?.announcesAt ?? "",
				) / 1000,
			);
			await receipt(market.seedTx);
			expect(market.pools).toHaveLength(3);
			for (const pool of market.pools) {
				const [sqrtPriceX96] = await fork.client.readContract({
					address: third("stateView"),
					abi: STATE_VIEW,
					functionName: "getSlot0",
					args: [poolId(pool)],
				});
				// Only the user's own trade below may have moved the first market's pools.
				if (market !== markets[0])
					expect(String(sqrtPriceX96)).toBe(pool.sqrtPriceX96);
				expect(sqrtPriceX96).toBeGreaterThan(0n);
				expect(
					await fork.client.readContract({
						address: at("FreezeHook"),
						abi: HOOK,
						functionName: "freezesAt",
						args: [poolId(pool)],
					}),
				).toBe(announcesAt);
			}
			for (const id of market.tokenIds) {
				const owner = await fork.client.readContract({
					address: third("positionManager"),
					abi: OWNERS,
					functionName: "ownerOf",
					args: [BigInt(id)],
				});
				expect(owner.toLowerCase()).toBe(treasury);
			}
		}
	});
});

describe("a user with only the faucet", () => {
	test("drips, enters and exits a market through the router", async () => {
		const market = markets[0];
		if (!market) throw new Error("no market to trade");
		const dollar = at("TestnetDollar");
		const router = {
			address: at("PositionRouter"),
			abi: artifact("src/PositionRouter.sol:PositionRouter").abi,
		};
		const token = artifact("src/testnet/TestnetToken.sol:TestnetToken").abi;
		await fork.client.request({
			method: "anvil_setBalance" as never,
			params: [USER, "0x56BC75E2D63100000"] as never,
		});
		await as(USER, dollar, token, "drip", []);
		const dripped = await fork.client.readContract({
			address: dollar,
			abi: ERC20,
			functionName: "balanceOf",
			args: [USER],
		});
		expect(dripped).toBeGreaterThan(0n);

		const deadline = (await fork.client.getBlock()).timestamp + 600n;
		const paid = dripped / 10n;
		await as(USER, dollar, ERC20, "approve", [router.address, maxUint256]);
		await as(USER, router.address, router.abi, "enter", [
			market.marketId,
			true,
			paid,
			1n,
			USER,
			deadline,
		]);
		const shares = await fork.client.readContract({
			address: market.legs.underlyingYes,
			abi: ERC20,
			functionName: "balanceOf",
			args: [USER],
		});
		const kept = await fork.client.readContract({
			address: market.legs.dollarNo,
			abi: ERC20,
			functionName: "balanceOf",
			args: [USER],
		});
		expect(shares).toBeGreaterThan(0n);
		expect(kept).toBe(paid);

		await as(USER, market.legs.underlyingYes, ERC20, "approve", [
			router.address,
			maxUint256,
		]);
		await as(USER, market.legs.dollarNo, ERC20, "approve", [
			router.address,
			maxUint256,
		]);
		await as(USER, router.address, router.abi, "exit", [
			{
				marketId: market.marketId,
				yes: true,
				shares,
				kept,
				minOut: 1n,
				levelSellsWorldDollar: false,
				level: 0n,
				minLevelOut: 0n,
				recipient: USER,
				deadline,
			},
		]);
		expect(
			await fork.client.readContract({
				address: market.legs.underlyingYes,
				abi: ERC20,
				functionName: "balanceOf",
				args: [USER],
			}),
		).toBe(0n);
		const back = await fork.client.readContract({
			address: dollar,
			abi: ERC20,
			functionName: "balanceOf",
			args: [USER],
		});
		// Round trip through two swaps at the pool fee: most of what was paid comes back as dollars.
		expect(back).toBeGreaterThan(dripped - paid + (paid * 95n) / 100n);
	});
});
