/**
 * The end-to-end gate a broadcast requires: on the rehearsed fork, through the addresses the rehearsal
 * deployed and the roles' own Safes, a price is published, an event is sealed and ruled through its
 * Safes, one market lives its whole life (split, pools opened and seeded, entered and undone through
 * the router, merged, frozen, proposed, disputed, settled, ruled, redeemed, a bond withdrawn), and an
 * event nobody resolves expires invalid.
 */
import {
	type Address,
	encodeFunctionData,
	type Hex,
	keccak256,
	maxUint256,
	parseAbi,
	parseEventLogs,
	toBytes,
} from "viem";
import { beforeAll, describe, expect, test } from "vitest";
import { attachFork, type Fork } from "../../../indexer/test/harness/fork.ts";
import {
	liveOneMarket,
	type MarketEnv,
	type Protocol,
	ROLES,
} from "../../../indexer/test/harness/protocol.ts";
import { artifact } from "../../src/artifacts.ts";
import { type Book, readBook } from "../../src/book.ts";
import { execData } from "../../src/safe.ts";

const url = process.env.REHEARSAL_RPC_URL;
const chainId = Number(process.env.REHEARSAL_CHAIN);
const bookFile = process.env.REHEARSAL_BOOK;
const DAY = 86_400n;
const ERC20 = parseAbi([
	"function approve(address, uint256) returns (bool)",
	"function balanceOf(address) view returns (uint256)",
]);

let fork: Fork;
let book: Book;
let protocol: Protocol;
let env: MarketEnv;

function entry(key: string): { address: Address } {
	const found = book[key] as { address: Address } | undefined;
	if (!found) throw new Error(`the rehearsal recorded no ${key}`);
	return found;
}

function contract(key: string, source: string) {
	return { address: entry(key).address, abi: artifact(source).abi };
}

function third(key: string): Address {
	const address = book.thirdParty?.[key]?.[0];
	if (!address) throw new Error(`no third-party ${key}`);
	return address;
}

function logical(name: string): Address {
	const [kind, key] = String(book.manifest?.logical[name]).split(":");
	return kind === "thirdParty"
		? third(String(key))
		: entry(String(key)).address;
}

/** A role's Safe makes a call, sent by its single owner with a pre-validated signature. */
async function throughSafe(role: "sealer" | "arbiter", to: Address, data: Hex) {
	const safe = book.roles?.[role];
	if (!safe) throw new Error(`no ${role} Safe`);
	const owner = safe.owners[0] as Address;
	const wallet = await fork.as(owner);
	const hash = await wallet.sendTransaction({
		to: safe.address,
		data: execData(to, data, owner),
		chain: null,
	});
	const receipt = await fork.client.waitForTransactionReceipt({ hash });
	expect(receipt.status).toBe("success");
	return receipt;
}

async function sealThroughSafe(
	value: bigint,
	announcesAt: bigint,
	deadline: bigint,
	terms: string,
) {
	const registry = protocol.registry;
	const receipt = await throughSafe(
		"sealer",
		registry.address,
		encodeFunctionData({
			abi: registry.abi,
			functionName: "seal",
			args: [
				{
					value,
					decimals: 2,
					announcesAt,
					deadline,
					terms: `0x${Buffer.from(terms).toString("hex")}`,
				},
			],
		}),
	);
	const [{ args }] = parseEventLogs({
		abi: registry.abi,
		logs: receipt.logs,
		eventName: "ThresholdSealed",
	}) as unknown as [{ args: { eventId: Hex; sealer: Address } }];
	return args;
}

async function call(
	from: Address,
	to: Address,
	abi: Parameters<typeof encodeFunctionData>[0]["abi"],
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
	const receipt = await fork.client.waitForTransactionReceipt({ hash });
	expect(receipt.status).toBe("success");
	return receipt;
}

beforeAll(async () => {
	if (!url || !bookFile || !chainId)
		throw new Error(
			"the gate runs on a rehearsal: REHEARSAL_RPC_URL, REHEARSAL_CHAIN and REHEARSAL_BOOK",
		);
	fork = await attachFork(url, chainId);
	book = readBook(bookFile);
	protocol = {
		firstBlock: 0n,
		factory: {
			...contract("MarketFactory", "src/MarketFactory.sol:MarketFactory"),
			block: 0n,
		},
		registry: {
			...contract(
				"ThresholdRegistry",
				"src/ThresholdRegistry.sol:ThresholdRegistry",
			),
			block: 0n,
		},
		resolver: {
			...contract(
				"OptimisticResolver",
				"src/OptimisticResolver.sol:OptimisticResolver",
			),
			block: 0n,
		},
		hook: contract("FreezeHook", "src/FreezeHook.sol:FreezeHook"),
		router: {
			...contract("PositionRouter", "src/PositionRouter.sol:PositionRouter"),
			block: 0n,
		},
	} as unknown as Protocol;
	const roles = book.roles ?? {};
	env = {
		underlying: book.manifest?.testnet
			? entry("TestnetStock.TSLA").address
			: third("collateral"),
		dollar: logical("dollar"),
		manager: third("poolManager"),
		roles: {
			...ROLES,
			sealer: roles.sealer?.address as typeof ROLES.sealer,
			arbiter: roles.arbiter?.address as typeof ROLES.arbiter,
			guardian: roles.guardian?.address as typeof ROLES.guardian,
		},
	};
});

describe("the rehearsed deployment", () => {
	test("every contract it recorded holds code, and the hook sits at an address carrying its flags", async () => {
		for (const key of [
			"MarketFactory",
			"ThresholdRegistry",
			"OptimisticResolver",
			"FreezeHook",
			"PositionRouter",
		]) {
			const code = await fork.client.getCode({ address: entry(key).address });
			expect(code && code.length > 2, key).toBe(true);
		}
		expect(BigInt(entry("FreezeHook").address) & 0x3fffn).toBe(0x2080n);
	});

	test("the price feed the manifest names reads back a round for every listed symbol", async () => {
		const oracle = logical("stockOracle");
		const abi = artifact(
			"src/testnet/TestnetStockOracle.sol:TestnetStockOracle",
		).abi;
		if (book.manifest?.testnet) {
			const now = (await fork.client.getBlock()).timestamp;
			const symbols = book.manifest.testnet.stocks.map((s) => s.symbol);
			expect(symbols.length).toBe(10);
			await call(book.manifest.publisher as Address, oracle, abi, "post", [
				symbols.map((symbol, i) => ({
					priceId: keccak256(toBytes(symbol)),
					price: BigInt(100e8 + i),
					bestBid: BigInt(99e8 + i),
					bestAsk: BigInt(101e8 + i),
					feedUpdateTimestamp: now,
				})),
			]);
			const round = (await fork.client.readContract({
				address: oracle,
				abi,
				functionName: "latestPrice",
				args: [keccak256(toBytes("NVDA"))],
			})) as readonly unknown[];
			expect(round[0]).toBe(BigInt(100e8 + 7));
			expect(round[6]).toBe(2);
		} else {
			// The production feed, read through the same function the keeper reads it with.
			const round = (await fork.client.readContract({
				address: oracle,
				abi,
				functionName: "latestPrice",
				args: [keccak256(toBytes("MU"))],
			})) as readonly unknown[];
			expect((round[5] as bigint) > 0n).toBe(true);
		}
	});

	test("a role's Safe seals an event, and the arbiter's Safe rules its disputed second proposal", async () => {
		const now = (await fork.client.getBlock()).timestamp;
		const { eventId, sealer } = await sealThroughSafe(
			3000n,
			now + DAY,
			now + 2n * DAY,
			"ruled through the arbiter's Safe",
		);
		expect(sealer.toLowerCase()).toBe(
			book.roles?.sealer?.address.toLowerCase(),
		);
		await fork.warp(DAY);
		const resolver = protocol.resolver;
		for (const who of [ROLES.proposer, ROLES.disputer]) {
			await fork.deal(env.dollar, who, 100n * 10n ** 6n);
			await call(who, env.dollar, ERC20, "approve", [
				resolver.address,
				maxUint256,
			]);
		}
		await call(
			ROLES.proposer,
			resolver.address,
			resolver.abi,
			"proposeFigure",
			[eventId, 2900n, 2],
		);
		await call(ROLES.disputer, resolver.address, resolver.abi, "dispute", [
			eventId,
			0,
		]);
		await call(
			ROLES.proposer,
			resolver.address,
			resolver.abi,
			"proposeFigure",
			[eventId, 3342n, 2],
		);
		await call(ROLES.disputer, resolver.address, resolver.abi, "dispute", [
			eventId,
			1,
		]);
		await throughSafe(
			"arbiter",
			resolver.address,
			encodeFunctionData({
				abi: resolver.abi,
				functionName: "ruleFigure",
				args: [eventId, 3342n, 2, true, "the issuer published 33.42"],
			}),
		);
		const factory = protocol.factory;
		const condition = (await fork.client.readContract({
			address: factory.address,
			abi: factory.abi,
			functionName: "condition",
			args: [resolver.address, eventId],
		})) as Hex;
		const outcome = await fork.client.readContract({
			address: factory.address,
			abi: factory.abi,
			functionName: "outcomeOf",
			args: [condition],
		});
		expect(outcome).toBe(1);
	});

	test("one market lives its whole life through the deployed router and pools", async () => {
		const life = await liveOneMarket(fork, protocol, env);
		expect(life.shares > 0n).toBe(true);
		const factory = protocol.factory;
		const condition = (await fork.client.readContract({
			address: factory.address,
			abi: factory.abi,
			functionName: "condition",
			args: [protocol.resolver.address, life.eventId],
		})) as Hex;
		const outcome = await fork.client.readContract({
			address: factory.address,
			abi: factory.abi,
			functionName: "outcomeOf",
			args: [condition],
		});
		expect(outcome).toBe(1);
	});

	test("an event nobody resolves expires invalid", async () => {
		const now = (await fork.client.getBlock()).timestamp;
		const { eventId } = await sealThroughSafe(
			100n,
			now + 60n,
			now + 120n,
			"left to expire",
		);
		const resolver = protocol.resolver;
		const expiresAt = (await fork.client.readContract({
			address: resolver.address,
			abi: resolver.abi,
			functionName: "expiresAt",
			args: [eventId],
		})) as bigint;
		const later = (await fork.client.getBlock()).timestamp;
		await fork.warp(expiresAt - later + 1n);
		await call(ROLES.holder, resolver.address, resolver.abi, "expire", [
			eventId,
		]);
		const factory = protocol.factory;
		const condition = (await fork.client.readContract({
			address: factory.address,
			abi: factory.abi,
			functionName: "condition",
			args: [resolver.address, eventId],
		})) as Hex;
		expect(
			await fork.client.readContract({
				address: factory.address,
				abi: factory.abi,
				functionName: "outcomeOf",
				args: [condition],
			}),
		).toBe(3);
	});
});
