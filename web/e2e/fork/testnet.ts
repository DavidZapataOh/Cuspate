/**
 * A local fork of the test network with one market opened on it the way the network's own markets
 * are opened: the threshold sealed from the sealer's Safe, the market created and registered, and
 * its two world pools opened at the condition's prices and seeded through the network's position
 * manager. The browser tests and the chain tests buy in it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { issuer, renderTerms } from "cuspate-shared";
import {
	type Address,
	createTestClient,
	createWalletClient,
	encodeAbiParameters,
	encodeFunctionData,
	encodePacked,
	getAddress,
	type Hex,
	http,
	maxUint256,
	numberToHex,
	parseAbi,
	publicActions,
	walletActions,
} from "viem";
import record from "../../../contracts/deployments/10143.json" with {
	type: "json",
};
import { type PoolKey, worldPool } from "../../src/chain/pools.ts";
import { contracts, stockOf, TESTNET } from "../../src/chain/record.ts";
import type { MarketBinding } from "../../src/data/model.ts";

/** The local node's first funded account, a well-known test key that holds nothing anywhere real. */
export const SEEDER: Address = getAddress(
	"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
);
/** The node's second funded account: the buyer the browser's test wallet signs for. */
export const BUYER: Address = getAddress(
	"0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
);

const REQUEST_TIMEOUT_MS = 120_000;

const abi = {
	registry: parseAbi([
		"struct Threshold { int256 value; uint8 decimals; uint64 announcesAt; uint64 deadline; bytes terms; }",
		"function seal(Threshold threshold) returns (bytes32)",
		"function eventIdOf(address sealer, Threshold threshold) pure returns (bytes32)",
	]),
	factory: parseAbi([
		"function createMarket(address underlying, address dollar, bytes32 eventId, address resolver, uint256 underlyingCap, uint256 dollarCap) returns (bytes32)",
		"function markets(bytes32) view returns (address underlyingVault, address dollarVault)",
	]),
	hook: parseAbi([
		"function register(bytes32 marketId, bytes32 eventId) returns (bytes32)",
	]),
	vault: parseAbi([
		"function splitPosition(uint256 amount)",
		"function YES() view returns (address)",
		"function NO() view returns (address)",
	]),
	manager: parseAbi([
		"function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24)",
	]),
	positions: parseAbi([
		"function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
	]),
	permit2: parseAbi([
		"function approve(address token, address spender, uint160 amount, uint48 expiration)",
	]),
	erc20: parseAbi([
		"function approve(address spender, uint256 amount) returns (bool)",
		"function balanceOf(address) view returns (uint256)",
	]),
};

const book = record as unknown as {
	OptimisticResolver: { address: Address };
	roles: Record<string, { address: Address }>;
	thirdParty: Record<string, Address[]>;
};
const third = (name: string) => getAddress(book.thirdParty[name]?.[0] ?? "");

/** The endpoint the fork reads the test network from: the environment's, or the public one. */
function upstream(): string {
	return (
		process.env.MONAD_TESTNET_RPC_URL ?? TESTNET.rpcUrls.default.http[0] ?? ""
	);
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address
					? resolve(address.port)
					: reject(new Error("no port")),
			);
		});
	});
}

/** A running fork of the test network, and a client with every action on it. */
export type Fork = Awaited<ReturnType<typeof startTestnetFork>>;

/** Starts a local node forking the test network at its latest block. */
export async function startTestnetFork() {
	const port = await freePort();
	const node: ChildProcess = spawn(
		"anvil",
		["--port", String(port), "--fork-url", upstream(), "--silent"],
		{ stdio: "ignore" },
	);
	const url = `http://127.0.0.1:${port}`;
	const client = createTestClient({
		mode: "anvil",
		transport: http(url, { timeout: REQUEST_TIMEOUT_MS }),
	})
		.extend(publicActions)
		.extend(walletActions);
	for (let attempt = 0; ; attempt++) {
		try {
			if ((await client.getChainId()) !== TESTNET.id)
				throw new Error("the node is not a fork of the test network");
			break;
		} catch (error) {
			if (attempt > 120) {
				node.kill();
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	/** Sends a call as `from`, which the node lets anyone impersonate, and waits for it. */
	async function send(from: Address, to: Address, data: Hex) {
		await client.impersonateAccount({ address: from });
		await client.setBalance({ address: from, value: 10n ** 22n });
		const wallet = createWalletClient({
			account: from,
			transport: http(url, { timeout: REQUEST_TIMEOUT_MS }),
		});
		const hash = await wallet.sendTransaction({ to, data, chain: null });
		const receipt = await client.waitForTransactionReceipt({ hash });
		if (receipt.status !== "success")
			throw new Error(`a call to ${to} reverted`);
		return receipt;
	}
	return {
		url,
		client,
		send,
		stop: () => node.kill(),
		/** Gives `holder` an amount of a token, and gas. */
		async fund(token: Address, holder: Address, amount: bigint) {
			await client.request({
				method: "anvil_dealERC20" as never,
				params: [holder, token, numberToHex(amount)] as never,
			});
			await client.setBalance({ address: holder, value: 10n ** 21n });
		},
	};
}

/** The square root of a raw price, as the pool manager's fixed-point number. */
function sqrtPriceX96(price: number): bigint {
	return BigInt(Math.floor(Math.sqrt(price) * 2 ** 96));
}

/** A world pool's opening: its key, price, and a position around the price from what is given. */
function plan(
	key: PoolKey,
	share: Address,
	priceCents: bigint,
	given: { share: bigint; dollar: bigint },
) {
	// Dollar units (six decimals) per share unit (eighteen).
	const perShare = (Number(priceCents) * 1e4) / 1e18;
	const shareFirst = key.currency0 === share;
	const price = shareFirst ? perShare : 1 / perShare;
	const tick = Math.floor(Math.log(price) / Math.log(1.0001));
	const lower = Math.floor((tick - 1800) / 60) * 60;
	const upper = Math.ceil((tick + 1800) / 60) * 60;
	const [sa, sp, sb] = [
		1.0001 ** (lower / 2),
		Math.sqrt(price),
		1.0001 ** (upper / 2),
	];
	const [amount0, amount1] = shareFirst
		? [given.share, given.dollar]
		: [given.dollar, given.share];
	const liquidity = Math.min(
		(Number(amount0) * 0.9 * sp * sb) / (sb - sp),
		(Number(amount1) * 0.9) / (sp - sa),
	);
	return {
		sqrtPrice: sqrtPriceX96(price),
		lower,
		upper,
		liquidity: BigInt(Math.floor(liquidity)),
		max0: amount0,
		max1: amount1,
	};
}

function mintData(
	key: PoolKey,
	p: ReturnType<typeof plan>,
	owner: Address,
	deadline: bigint,
): Hex {
	const keyType = {
		type: "tuple",
		components: [
			{ name: "currency0", type: "address" },
			{ name: "currency1", type: "address" },
			{ name: "fee", type: "uint24" },
			{ name: "tickSpacing", type: "int24" },
			{ name: "hooks", type: "address" },
		],
	} as const;
	const mint = encodeAbiParameters(
		[
			keyType,
			{ type: "int24" },
			{ type: "int24" },
			{ type: "uint256" },
			{ type: "uint128" },
			{ type: "uint128" },
			{ type: "address" },
			{ type: "bytes" },
		],
		[key, p.lower, p.upper, p.liquidity, p.max0, p.max1, owner, "0x"],
	);
	const settle = encodeAbiParameters(
		[{ type: "address" }, { type: "address" }],
		[key.currency0, key.currency1],
	);
	// The position manager's actions: mint a position (0x02), then settle the pair (0x0d).
	const unlockData = encodeAbiParameters(
		[{ type: "bytes" }, { type: "bytes[]" }],
		[encodePacked(["uint8", "uint8"], [0x02, 0x0d]), [mint, settle]],
	);
	return encodeFunctionData({
		abi: abi.positions,
		functionName: "modifyLiquidities",
		args: [unlockData, deadline],
	});
}

/** What opening a market needs: the condition, its prices, and how much each vault may hold. */
export type MarketSpec = {
	eventKey: string;
	conditionKey: string;
	ticker: string;
	period: { quarter: 1 | 2 | 3 | 4; fiscalYear: number };
	/** The threshold, in cents. */
	threshold: bigint;
	announcesAt: string;
	/** What a share costs in each world, in cents. */
	yesWorldPriceCents: bigint;
	noWorldPriceCents: bigint;
	/** How many dollars the dollar vault may hold, in its units; the default leaves ample room. */
	dollarCap?: bigint;
};

/** Opens a market on the fork as the network opens its own, and says what the record would say. */
export async function openMarket(
	fork: Fork,
	spec: MarketSpec,
): Promise<{ key: string; binding: MarketBinding; eventId: Hex }> {
	const announcesAt = BigInt(Date.parse(spec.announcesAt) / 1000);
	const deadline = announcesAt + 4n * 86_400n;
	// The terms name the rehearsal, so its event is never the network's own: an event the network
	// has already sealed stays sealed on every fork taken after it.
	const terms = renderTerms(issuer(spec.ticker), {
		period: spec.period,
		fallback:
			"the issuer's earnings release on its investor relations website, in a rehearsal on a fork",
		fallbackFrom: new Date(Number(announcesAt + 86_400n) * 1000)
			.toISOString()
			.replace(/\.\d{3}Z$/, "Z"),
	});
	const threshold = {
		value: spec.threshold,
		decimals: 2,
		announcesAt,
		deadline,
		terms: `0x${Buffer.from(terms).toString("hex")}` as Hex,
	};
	const sealer = getAddress(book.roles.sealer?.address ?? "");
	const registry = getAddress(
		(record as unknown as Record<string, { address: string }>).ThresholdRegistry
			?.address ?? "",
	);
	await fork.send(
		sealer,
		registry,
		encodeFunctionData({
			abi: abi.registry,
			functionName: "seal",
			args: [threshold],
		}),
	);
	const eventId = await fork.client.readContract({
		address: registry,
		abi: abi.registry,
		functionName: "eventIdOf",
		args: [sealer, threshold],
	});

	const stock = stockOf(spec.ticker);
	const createArgs = [
		stock,
		contracts.dollar,
		eventId,
		getAddress(book.OptimisticResolver.address),
		10_000n * 10n ** 18n,
		spec.dollarCap ?? 10_000_000n * 10n ** 6n,
	] as const;
	const { result: marketId } = await fork.client.simulateContract({
		account: SEEDER,
		address: contracts.factory,
		abi: abi.factory,
		functionName: "createMarket",
		args: createArgs,
	});
	await fork.send(
		SEEDER,
		contracts.factory,
		encodeFunctionData({
			abi: abi.factory,
			functionName: "createMarket",
			args: createArgs,
		}),
	);
	await fork.send(
		SEEDER,
		contracts.hook,
		encodeFunctionData({
			abi: abi.hook,
			functionName: "register",
			args: [marketId, eventId],
		}),
	);
	const [underlyingVault, dollarVault] = await fork.client.readContract({
		address: contracts.factory,
		abi: abi.factory,
		functionName: "markets",
		args: [marketId],
	});
	const leg = (vault: Address, fn: "YES" | "NO") =>
		fork.client.readContract({
			address: vault,
			abi: abi.vault,
			functionName: fn,
		});
	const legs = {
		underlyingYes: await leg(underlyingVault, "YES"),
		underlyingNo: await leg(underlyingVault, "NO"),
		dollarYes: await leg(dollarVault, "YES"),
		dollarNo: await leg(dollarVault, "NO"),
	};

	// The seeder splits stock and dollars into both worlds, then seeds each world's pool.
	const shares = 200n * 10n ** 18n;
	const dollars = 200_000n * 10n ** 6n;
	await fork.fund(stock, SEEDER, shares);
	await fork.fund(contracts.dollar, SEEDER, dollars);
	for (const [token, vault, amount] of [
		[stock, underlyingVault, shares],
		[contracts.dollar, dollarVault, dollars],
	] as const) {
		await fork.send(
			SEEDER,
			token,
			encodeFunctionData({
				abi: abi.erc20,
				functionName: "approve",
				args: [vault, amount],
			}),
		);
		await fork.send(
			SEEDER,
			vault,
			encodeFunctionData({
				abi: abi.vault,
				functionName: "splitPosition",
				args: [amount],
			}),
		);
	}
	const permit2 = third("permit2");
	const positions = third("positionManager");
	for (const token of Object.values(legs)) {
		await fork.send(
			SEEDER,
			token,
			encodeFunctionData({
				abi: abi.erc20,
				functionName: "approve",
				args: [permit2, maxUint256],
			}),
		);
		await fork.send(
			SEEDER,
			permit2,
			encodeFunctionData({
				abi: abi.permit2,
				functionName: "approve",
				args: [token, positions, 2n ** 160n - 1n, 2 ** 48 - 1],
			}),
		);
	}
	const now = (await fork.client.getBlock()).timestamp;
	for (const yes of [true, false]) {
		const { key } = worldPool(legs, yes, contracts.hook);
		const share = yes ? legs.underlyingYes : legs.underlyingNo;
		const price = yes ? spec.yesWorldPriceCents : spec.noWorldPriceCents;
		const p = plan(key, share, price, { share: shares, dollar: dollars });
		await fork.send(
			SEEDER,
			third("poolManager"),
			encodeFunctionData({
				abi: abi.manager,
				functionName: "initialize",
				args: [key, p.sqrtPrice],
			}),
		);
		await fork.send(SEEDER, positions, mintData(key, p, SEEDER, now + 3_600n));
	}
	return {
		key: `${spec.eventKey}/${spec.conditionKey}`,
		eventId,
		binding: { marketId, dollarVault, legs },
	};
}
