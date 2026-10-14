/**
 * The keeper's levelling swap against the Universal Router the public test network actually runs, on
 * a fork of it. The two networks' routers decode different single-pool swap parameters, so the bytes
 * the keeper builds from its configuration are sent as they are, from an account holding only the
 * dollar leg it sells, and the swap must settle.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Address,
	encodeFunctionData,
	type Hex,
	type PublicClient,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { attachFork, type Fork } from "../../indexer/test/harness/fork";
import { ERC20, PERMIT2 } from "../src/abis.ts";
import { type Config, configFromEnv } from "../src/config.ts";
import { levelCall, quoteIn } from "../src/correction.ts";
import { type Market, priceIdOf, readMarket } from "../src/market.ts";

const TESTNET = 10143;
const here = path.dirname(fileURLToPath(import.meta.url));
const book = JSON.parse(
	readFileSync(
		path.join(here, `../../contracts/deployments/${TESTNET}.json`),
		"utf8",
	),
) as Record<string, { address: Address }>;
const kept = JSON.parse(
	readFileSync(path.join(here, `../markets/${TESTNET}.json`), "utf8"),
) as { markets: { marketId: Hex; symbol: string }[] };

const HOLDER: Address = "0x00000000000000000000000000000000000b0004";
/** One dollar of a dollar leg, which carries the dollar's six decimals. */
const AMOUNT = 10n ** 6n;

let node: ChildProcess;
let fork: Fork;
let config: Config;
let market: Market;

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

const client = () => fork.client as unknown as PublicClient;
const balance = (token: Address) =>
	fork.client.readContract({
		address: token,
		abi: ERC20,
		functionName: "balanceOf",
		args: [HOLDER],
	});

beforeAll(async () => {
	const port = await freePort();
	node = spawn(
		"anvil",
		[
			"--port",
			String(port),
			"--fork-url",
			process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
			"--silent",
		],
		{ stdio: "ignore" },
	);
	fork = await attachFork(`http://127.0.0.1:${port}`, TESTNET);
	config = configFromEnv({
		KEEPER_CHAIN: String(TESTNET),
		KEEPER_RPC_URL: fork.url,
		KEEPER_KEY: generatePrivateKey(),
		KEEPER_SAFE: HOLDER,
		KEEPER_MARKETS_FILE: path.join(here, `../markets/${TESTNET}.json`),
		KEEPER_STATE_DIR: "/nonexistent",
		CUSPATE_MARKET_FACTORY: book.MarketFactory.address,
		CUSPATE_FREEZE_HOOK: book.FreezeHook.address,
		CUSPATE_POSITION_ROUTER: book.PositionRouter.address,
		CUSPATE_RESOLVER: book.OptimisticResolver.address,
	});
	// The first kept market whose probability pool still trades: a frozen one refuses the quote.
	for (const { marketId, symbol } of kept.markets) {
		const candidate = await readMarket(
			client(),
			config.deployment,
			marketId,
			priceIdOf(symbol),
		);
		try {
			const out = await quoteIn(
				client(),
				config.deployment,
				candidate.probabilityKey,
				candidate.legs.dollarYes,
				AMOUNT,
			);
			if (out > 0n) {
				market = candidate;
				break;
			}
		} catch {}
	}
	if (market === undefined)
		throw new Error("no kept market on the test network trades");
}, 600_000);

afterAll(() => {
	node?.kill();
});

describe("the keeper's levelling swap on the test network", () => {
	test("settles through the deployed Universal Router", async () => {
		const sold = market.legs.dollarYes;
		const key = market.probabilityKey;
		const bought = key.currency0 === sold ? key.currency1 : key.currency0;
		const minOut = await quoteIn(
			client(),
			config.deployment,
			key,
			sold,
			AMOUNT,
		);
		await fork.deal(sold, HOLDER, AMOUNT);
		const wallet = await fork.as(HOLDER);
		const send = async (to: Address, data: Hex) => {
			const hash = await wallet.sendTransaction({ to, data, chain: null });
			return fork.client.waitForTransactionReceipt({ hash });
		};
		const { permit2, universalRouter } = config.deployment;
		await send(
			sold,
			encodeFunctionData({
				abi: ERC20,
				functionName: "approve",
				args: [permit2, AMOUNT],
			}),
		);
		await send(
			permit2,
			encodeFunctionData({
				abi: PERMIT2,
				functionName: "approve",
				args: [sold, universalRouter, AMOUNT, 2 ** 48 - 1],
			}),
		);
		const before = await balance(bought);
		const level = levelCall(
			config.deployment,
			market,
			sold,
			AMOUNT,
			minOut,
			(await fork.client.getBlock()).timestamp + 600n,
		);
		// The router's own verdict first, so a refusal names itself instead of a bare failed receipt.
		await fork.client.call({ account: HOLDER, to: level.to, data: level.data });
		const receipt = await send(level.to, level.data);
		expect(receipt.status).toBe("success");
		expect(await balance(sold)).toBe(0n);
		expect((await balance(bought)) - before).toBeGreaterThanOrEqual(minOut);
	});
});
