/**
 * The keeper against a market on a fork of the production chain at the pinned block, its pools opened
 * coherent with the feed as the contracts' own coherence test opens them: it corrects legs made rich or
 * cheap into the band, and it never makes a correction twice, across a restart before or after
 * sending, two instances, and a key nonce taken by another transaction.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type Abi,
	type Address,
	createWalletClient,
	type Hex,
	http,
	maxUint256,
	type PublicClient,
	parseAbi,
	parseEventLogs,
	zeroAddress,
	zeroHash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import {
	artifact,
	CHAIN_ID,
	deploy,
	FORK_REQUEST_TIMEOUT_MS,
	type Fork,
	startFork,
	thirdParty,
} from "../../indexer/test/harness/fork";
import {
	deployProtocol,
	type Protocol,
	ROLES,
} from "../../indexer/test/harness/protocol";
import {
	ERC20,
	ROUTER,
	SAFE,
	SAFE_FACTORY,
	STATE_VIEW,
	VAULT,
} from "../src/abis.ts";
import { executionData } from "../src/account.ts";
import {
	band,
	sqrtPriceAtYesDollarPrice,
	sqrtPriceX96,
} from "../src/arithmetic.ts";
import { ROUTER_MIN_HOP_PRICE } from "../src/config.ts";
import { takeFollowUps } from "../src/followups.ts";
import { Keeper } from "../src/keeper.ts";
import {
	type Deployment,
	type Market,
	poolId,
	readImplied,
	readMarket,
	readQuote,
} from "../src/market.ts";
import { watch } from "../src/monitor.ts";
import { type Simulator, startSimulator } from "../src/simulator.ts";
import { Store } from "../src/store.ts";

const ERC20_TRANSFER = parseAbi([
	"function transfer(address to, uint256 amount) returns (bool)",
]);

const HOLDER: Address = "0x00000000000000000000000000000000000b0002";
const WHALE: Address = "0x00000000000000000000000000000000000b0003";
const owner = privateKeyToAccount(generatePrivateKey());

let fork: Fork;
let protocol: Protocol;
let deployment: Deployment;
let market: Market;
let safe: Address;
let simulator: Simulator;
let snapshot: Hex;
let eventId: Hex;

const client = () => fork.client as unknown as PublicClient;

async function send(
	from: Address,
	to: Address,
	abi: Abi,
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
	});
	const receipt = await fork.client.waitForTransactionReceipt({ hash });
	if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
	return receipt;
}

/** Opens a pool at a sqrt price and seeds it about a fifth either side, as the coherence test does. */
async function open(
	seeder: Address,
	key: Market["yesKey"],
	sqrtPrice: bigint,
	liquidity: bigint,
) {
	await send(
		HOLDER,
		thirdParty("poolManager"),
		artifact("IPoolManager").abi,
		"initialize",
		[key, sqrtPrice],
	);
	const [, tick] = await fork.client.readContract({
		address: thirdParty("stateView"),
		abi: STATE_VIEW,
		functionName: "getSlot0",
		args: [poolId(key)],
	});
	// Solidity's division, truncating toward zero.
	const lower = (BigInt(tick - 1823) / 60n) * 60n - 60n;
	const upper = (BigInt(tick + 1823) / 60n) * 60n + 60n;
	await send(
		HOLDER,
		seeder,
		artifact("PoolModifyLiquidityTest").abi,
		"modifyLiquidity",
		[
			key,
			{
				tickLower: Number(lower),
				tickUpper: Number(upper),
				liquidityDelta: liquidity,
				salt: zeroHash,
			},
			"0x",
		],
	);
}

beforeAll(async () => {
	fork = await startFork();
	protocol = await deployProtocol(fork);
	deployment = {
		factory: protocol.factory.address,
		hook: protocol.hook.address,
		router: protocol.router.address,
		stateView: thirdParty("stateView"),
		quoter: thirdParty("v4Quoter"),
		oracle: thirdParty("stockOracle"),
		permit2: thirdParty("permit2"),
		universalRouter: thirdParty("universalRouter"),
		universalRouterMinHopPrice: ROUTER_MIN_HOP_PRICE[String(CHAIN_ID)],
	};
	const underlying = thirdParty("collateral");
	const dollar = thirdParty("dollar");
	const now = (await fork.client.getBlock()).timestamp;
	const sealed = await send(
		ROLES.sealer,
		protocol.registry.address,
		protocol.registry.abi,
		"seal",
		[
			{
				value: 1n,
				decimals: 0,
				announcesAt: now + 86_400n,
				deadline: now + 172_800n,
				terms: "0x636f686572656e6365",
			},
		],
	);
	const [{ args: seal }] = parseEventLogs({
		abi: protocol.registry.abi,
		logs: sealed.logs,
		eventName: "ThresholdSealed",
	}) as unknown as [{ args: { eventId: Hex } }];
	const created = await send(
		HOLDER,
		protocol.factory.address,
		protocol.factory.abi,
		"createMarket",
		[
			underlying,
			dollar,
			seal.eventId,
			protocol.resolver.address,
			30n * 10n ** 18n + 10n * 10n ** 18n,
			45_000n * 10n ** 6n + 1_000_000n * 10n ** 6n,
		],
	);
	const [{ args: made }] = parseEventLogs({
		abi: protocol.factory.abi,
		logs: created.logs,
		eventName: "MarketCreated",
	}) as unknown as [{ args: { marketId: Hex } }];
	await send(HOLDER, protocol.hook.address, protocol.hook.abi, "register", [
		made.marketId,
		seal.eventId,
	]);
	market = await readMarket(client(), deployment, made.marketId);
	eventId = seal.eventId;

	// Seed the three pools coherent with the feed: 1,100 and 1,023.4625 dollars a share, probability 0.6.
	await fork.deal(underlying, HOLDER, 30n * 10n ** 18n);
	await fork.deal(dollar, HOLDER, 45_000n * 10n ** 6n);
	await send(HOLDER, underlying, ERC20, "approve", [
		market.underlyingVault,
		maxUint256,
	]);
	await send(HOLDER, dollar, ERC20, "approve", [
		market.dollarVault,
		maxUint256,
	]);
	await send(HOLDER, market.underlyingVault, VAULT, "splitPosition", [
		30n * 10n ** 18n,
	]);
	await send(HOLDER, market.dollarVault, VAULT, "splitPosition", [
		45_000n * 10n ** 6n,
	]);
	const seeder = await deploy(fork, "PoolModifyLiquidityTest", [
		thirdParty("poolManager"),
	]);
	for (const leg of Object.values(market.legs))
		await send(HOLDER, leg, ERC20, "approve", [seeder.address, maxUint256]);
	const decimals = (token: Address) =>
		token === market.legs.underlyingYes || token === market.legs.underlyingNo
			? 18
			: 6;
	const world = (
		key: Market["yesKey"],
		share: Address,
		price: bigint,
		priceDecimals: number,
	) =>
		sqrtPriceX96({
			price,
			priceDecimals,
			baseIsFirst: key.currency0 === share,
			decimals0: decimals(key.currency0),
			decimals1: decimals(key.currency1),
		});
	await open(
		seeder.address,
		market.yesKey,
		world(market.yesKey, market.legs.underlyingYes, 1100n, 0),
		10n ** 16n,
	);
	await open(
		seeder.address,
		market.noKey,
		world(market.noKey, market.legs.underlyingNo, 10_234_625n, 4),
		10n ** 16n,
	);
	await open(
		seeder.address,
		market.probabilityKey,
		sqrtPriceAtYesDollarPrice(
			6n * 10n ** 17n,
			BigInt(market.legs.dollarYes) < BigInt(market.legs.dollarNo),
		),
		10n ** 11n,
	);

	// The keeper's Safe, owned by its key alone, holding two shares and five thousand dollars.
	await fork.client.setBalance({ address: owner.address, value: 10n ** 22n });
	const initializer = (await import("viem")).encodeFunctionData({
		abi: SAFE,
		functionName: "setup",
		args: [
			[owner.address],
			1n,
			zeroAddress,
			"0x",
			thirdParty("safeFallbackHandler"),
			zeroAddress,
			0n,
			zeroAddress,
		],
	});
	const deployed = await send(
		HOLDER,
		thirdParty("safeProxyFactory"),
		SAFE_FACTORY,
		"createProxyWithNonce",
		[thirdParty("safeSingleton"), initializer, 1n],
	);
	const [{ args: proxy }] = parseEventLogs({
		abi: SAFE_FACTORY,
		logs: deployed.logs,
		eventName: "ProxyCreation",
	}) as unknown as [{ args: { proxy: Address } }];
	safe = proxy.proxy;
	await fork.deal(underlying, safe, 2n * 10n ** 18n);
	await fork.deal(dollar, safe, 5_000n * 10n ** 6n);
	simulator = await startSimulator(fork.url);
}, 600_000);

afterAll(() => {
	simulator?.stop();
	fork?.stop();
});

beforeEach(async () => {
	snapshot = await fork.client.snapshot();
});

afterEach(async () => {
	await fork.client.revert({ id: snapshot });
});

function keeper(
	store = new Store(mkdtempSync(path.join(tmpdir(), "keeper-"))),
) {
	return new Keeper({
		client: client(),
		wallet: createWalletClient({
			transport: http(fork.url, { timeout: FORK_REQUEST_TIMEOUT_MS }),
		}),
		owner,
		safe,
		multiSend: thirdParty("safeMultiSendCallOnly"),
		deployment,
		market,
		simulator,
		store,
		clip: maxUint256,
		receiptTimeoutMs: 30_000,
	});
}

async function whaleBuys(dollars: bigint) {
	const dollar = thirdParty("dollar");
	await fork.deal(dollar, WHALE, 2n * dollars);
	await send(WHALE, dollar, ERC20, "approve", [
		protocol.router.address,
		maxUint256,
	]);
	const deadline = (await fork.client.getBlock()).timestamp + 300n;
	for (const yes of [true, false])
		await send(WHALE, protocol.router.address, ROUTER, "enter", [
			market.marketId,
			yes,
			dollars,
			1n,
			WHALE,
			deadline,
		]);
}

async function whaleSells(shares: bigint) {
	const underlying = thirdParty("collateral");
	await fork.deal(underlying, WHALE, shares);
	await send(WHALE, underlying, ERC20, "approve", [
		market.underlyingVault,
		maxUint256,
	]);
	await send(WHALE, market.underlyingVault, VAULT, "splitPosition", [shares]);
	const deadline = (await fork.client.getBlock()).timestamp + 300n;
	for (const [yes, leg] of [
		[true, market.legs.underlyingYes],
		[false, market.legs.underlyingNo],
	] as const) {
		await send(WHALE, leg, ERC20, "approve", [
			protocol.router.address,
			maxUint256,
		]);
		await send(WHALE, protocol.router.address, ROUTER, "exit", [
			{
				marketId: market.marketId,
				yes,
				shares,
				kept: 0n,
				minOut: 1n,
				levelSellsWorldDollar: false,
				level: 0n,
				minLevelOut: 0n,
				recipient: WHALE,
				deadline,
			},
		]);
	}
}

const edges = async () => {
	const quote = await readQuote(client(), deployment, market);
	return {
		...band(quote.bid, quote.ask),
		bid: quote.bid * 10n ** 10n,
		ask: quote.ask * 10n ** 10n,
	};
};
const implied = () => readImplied(client(), deployment, market);
/** Whether a price is at an edge to within a millionth of it, as the reference keeper lands. */
const atEdge = (price: bigint, edge: bigint) =>
	(price > edge ? price - edge : edge - price) * 10n ** 6n <= edge;

/** The account keeps no leg beyond dust: a correction leaves it holding what it held. */
async function expectFlat() {
	const held = (leg: Address) =>
		fork.client.readContract({
			address: leg,
			abi: ERC20,
			functionName: "balanceOf",
			args: [safe],
		});
	expect(await held(market.legs.underlyingYes)).toBeLessThanOrEqual(10n ** 10n);
	expect(await held(market.legs.underlyingNo)).toBeLessThanOrEqual(10n ** 10n);
	expect(await held(market.legs.dollarYes)).toBeLessThanOrEqual(10n);
	expect(await held(market.legs.dollarNo)).toBeLessThanOrEqual(10n);
}

const safeNonce = () =>
	fork.client.readContract({ address: safe, abi: SAFE, functionName: "nonce" });

describe("the keeper", () => {
	test("stays still while the market is in the band", async () => {
		const { lower, upper } = await edges();
		expect(await implied()).toBeGreaterThanOrEqual(lower);
		expect(await implied()).toBeLessThanOrEqual(upper);
		expect(await keeper().step()).toEqual({ kind: "idle", reason: "in-band" });
	});

	test("corrects rich legs to the band's upper edge in one batch", async () => {
		await whaleBuys(2_500n * 10n ** 6n);
		const { upper, ask } = await edges();
		expect(await implied()).toBeGreaterThan(upper);
		expect((await keeper().step()).kind).toBe("corrected");
		const after = await implied();
		expect(after).toBeLessThanOrEqual(upper);
		expect(after).toBeGreaterThanOrEqual(ask);
		expect(atEdge(after, upper)).toBe(true);
		await expectFlat();
	});

	test("corrects cheap legs to the band's lower edge in one batch", async () => {
		await whaleSells(2n * 10n ** 18n);
		const { lower, bid } = await edges();
		expect(await implied()).toBeLessThan(lower);
		expect((await keeper().step()).kind).toBe("corrected");
		const after = await implied();
		expect(after).toBeGreaterThanOrEqual(lower);
		expect(after).toBeLessThanOrEqual(bid);
		expect(atEdge(after, lower)).toBe(true);
		await expectFlat();
	});

	test("after a restart between signing and sending, sends the recorded batch once", async () => {
		await whaleBuys(2_500n * 10n ** 6n);
		const store = new Store(mkdtempSync(path.join(tmpdir(), "keeper-")));
		const prepared = await keeper(store).prepare();
		expect("kind" in prepared).toBe(false);
		const before = await safeNonce();
		expect((await keeper(store).step()).kind).toBe("corrected");
		expect(await safeNonce()).toBe(before + 1n);
		expect(await keeper(store).step()).toEqual({
			kind: "idle",
			reason: "in-band",
		});
	});

	test("after a restart between sending and recording it, recognises the batch as done", async () => {
		await whaleBuys(2_500n * 10n ** 6n);
		const store = new Store(mkdtempSync(path.join(tmpdir(), "keeper-")));
		const prepared = await keeper(store).prepare();
		if ("kind" in prepared) throw new Error("nothing was prepared");
		const before = await safeNonce();
		// The batch went out, and the process stopped before it recorded so.
		const wallet = createWalletClient({
			transport: http(fork.url, { timeout: FORK_REQUEST_TIMEOUT_MS }),
		});
		await fork.client.waitForTransactionReceipt({
			hash: await wallet.sendTransaction({
				account: owner,
				to: safe,
				data: executionData(prepared),
				chain: null,
			}),
		});
		expect((await keeper(store).step()).kind).toBe("superseded");
		expect(await safeNonce()).toBe(before + 1n);
		expect(store.pending(market.marketId)).toBeUndefined();
	});

	test("two instances that sign the same correction make it once", async () => {
		await whaleBuys(2_500n * 10n ** 6n);
		const first = keeper();
		const second = keeper();
		const a = await first.prepare();
		const b = await second.prepare();
		if ("kind" in a || "kind" in b) throw new Error("nothing was prepared");
		expect(a.safeNonce).toBe(b.safeNonce);
		const before = await safeNonce();
		expect((await first.finish(a)).kind).toBe("corrected");
		expect((await second.finish(b)).kind).toBe("superseded");
		expect(await safeNonce()).toBe(before + 1n);
		// Even sent anyway, the second signature cannot execute: the nonce it signed is spent.
		const wallet = createWalletClient({
			transport: http(fork.url, { timeout: FORK_REQUEST_TIMEOUT_MS }),
		});
		const hash = await wallet.sendTransaction({
			account: owner,
			to: safe,
			data: executionData(b),
			gas: 3_000_000n,
			chain: null,
		});
		expect((await fork.client.waitForTransactionReceipt({ hash })).status).toBe(
			"reverted",
		);
		expect(await safeNonce()).toBe(before + 1n);
	});

	test("resubmits once with a fresh key nonce when another transaction took the recorded one", async () => {
		await whaleBuys(2_500n * 10n ** 6n);
		const store = new Store(mkdtempSync(path.join(tmpdir(), "keeper-")));
		const prepared = await keeper(store).prepare();
		if ("kind" in prepared) throw new Error("nothing was prepared");
		const wallet = createWalletClient({
			transport: http(fork.url, { timeout: FORK_REQUEST_TIMEOUT_MS }),
		});
		await fork.client.waitForTransactionReceipt({
			hash: await wallet.sendTransaction({
				account: owner,
				to: owner.address,
				value: 0n,
				nonce: prepared.keyNonce,
				chain: null,
			}),
		});
		const before = await safeNonce();
		expect((await keeper(store).step()).kind).toBe("corrected");
		expect(await safeNonce()).toBe(before + 1n);
	});
});

describe("the keeper's follow-ups, against the resolver", () => {
	const PROPOSER: Address = "0x00000000000000000000000000000000000b0004";
	const DISPUTER: Address = "0x00000000000000000000000000000000000b0005";

	/** A fresh event that can be proposed for now, and bonds for both sides. */
	async function freshEvent(): Promise<Hex> {
		// The node stamps a new block with its own clock, which runs on while the tests before this one
		// take their time; a block mined now carries the time the seal will be checked against.
		await fork.client.mine({ blocks: 1 });
		const now = (await fork.client.getBlock()).timestamp;
		const sealed = await send(
			ROLES.sealer,
			protocol.registry.address,
			protocol.registry.abi,
			"seal",
			[
				{
					value: 1n,
					decimals: 0,
					announcesAt: now + 60n,
					deadline: now + 86_460n,
					terms: `0x${now.toString(16).padStart(8, "0")}`,
				},
			],
		);
		const [{ args }] = parseEventLogs({
			abi: protocol.registry.abi,
			logs: sealed.logs,
			eventName: "ThresholdSealed",
		}) as unknown as [{ args: { eventId: Hex } }];
		await fork.warp(61n);
		for (const who of [PROPOSER, DISPUTER]) {
			await fork.deal(thirdParty("dollar"), who, 10n * 10n ** 6n);
			await send(who, thirdParty("dollar"), ERC20, "approve", [
				protocol.resolver.address,
				maxUint256,
			]);
		}
		return args.eventId;
	}

	const take = (eventId: Hex) =>
		takeFollowUps(
			client(),
			createWalletClient({
				transport: http(fork.url, { timeout: FORK_REQUEST_TIMEOUT_MS }),
			}),
			owner,
			protocol.resolver.address,
			eventId,
		);

	test("settles a proposal once its window closes, and only once", async () => {
		const eventId = await freshEvent();
		await send(
			PROPOSER,
			protocol.resolver.address,
			protocol.resolver.abi,
			"proposeFigure",
			[eventId, 2n, 0],
		);
		expect(await take(eventId)).toEqual([]);
		await fork.warp(3600n);
		expect(await take(eventId)).toEqual(["settle"]);
		expect(await take(eventId)).toEqual([]);
	});

	test("releases a first contest the arbiter never ruled, once its timeout passes", async () => {
		const eventId = await freshEvent();
		await send(
			PROPOSER,
			protocol.resolver.address,
			protocol.resolver.abi,
			"proposeFigure",
			[eventId, 2n, 0],
		);
		await send(
			DISPUTER,
			protocol.resolver.address,
			protocol.resolver.abi,
			"dispute",
			[eventId, 0],
		);
		await fork.warp(3600n + 7n * 86_400n - 120n);
		expect(await take(eventId)).toEqual([]);
		await fork.warp(240n);
		expect(await take(eventId)).toEqual(["release"]);
		expect(await take(eventId)).toEqual([]);
	});

	test("expires an event nobody proposed for, once it expires", async () => {
		const eventId = await freshEvent();
		await fork.warp(86_400n + 7n * 86_400n - 120n);
		expect(await take(eventId)).toEqual([]);
		await fork.warp(240n);
		expect(await take(eventId)).toEqual(["expire"]);
		expect(await take(eventId)).toEqual([]);
	});
});

describe("the monitor", () => {
	const alerts = () =>
		watch(
			client(),
			{ ...deployment, resolver: protocol.resolver.address },
			market,
			eventId,
			150n,
			"latest",
		);

	test("is quiet on a healthy market", async () => {
		expect(await alerts()).toEqual([]);
	});

	test("a vault short by a single unit raises a critical solvency alert on the next poll", async () => {
		// The breach is a real transfer out of the vault, as only a fault in the vault could make it.
		const vault = await fork.as(market.underlyingVault);
		await fork.client.waitForTransactionReceipt({
			hash: await vault.writeContract({
				address: market.underlying,
				abi: ERC20_TRANSFER,
				functionName: "transfer",
				args: [WHALE, 1n],
				chain: null,
			}),
		});
		const raised = await alerts();
		expect(raised).toHaveLength(1);
		expect(raised[0]).toMatchObject({
			severity: "critical",
			watcher: "solvency",
			subject: market.underlyingVault,
		});
	});
});
