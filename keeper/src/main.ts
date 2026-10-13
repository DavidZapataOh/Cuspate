/**
 * The keeper as a service: one market, one step every interval, its follow-ups after each step, one
 * line of JSON per step. Run with `node src/main.ts`; its settings are in `config.ts`.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { configFromEnv } from "./config.ts";
import { takeFollowUps } from "./followups.ts";
import { Keeper } from "./keeper.ts";
import { readMarket } from "./market.ts";
import { startSimulator } from "./simulator.ts";
import { Store } from "./store.ts";

const config = configFromEnv(process.env);
const store = new Store(config.stateDir);
if (!store.lock())
	throw new Error(`another keeper holds the lock in ${config.stateDir}`);
const client = createPublicClient({ transport: http(config.rpcUrl) });
const wallet = createWalletClient({ transport: http(config.rpcUrl) });
const owner = privateKeyToAccount(config.key);
const simulator = await startSimulator(config.rpcUrl);
const keeper = new Keeper({
	client,
	wallet,
	owner,
	safe: config.safe,
	multiSend: config.multiSend,
	deployment: config.deployment,
	market: await readMarket(client, config.deployment, config.marketId),
	simulator,
	store,
	clip: config.clip,
	receiptTimeoutMs: 60_000,
});

let running = true;
const stop = () => {
	running = false;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const replacer = (_: string, value: unknown) =>
	typeof value === "bigint" ? value.toString() : value;
while (running) {
	try {
		const step = await keeper.step();
		const followUps = await takeFollowUps(
			client,
			wallet,
			owner,
			config.resolver,
			config.eventId,
		);
		console.log(
			JSON.stringify(
				{ at: new Date().toISOString(), step, followUps },
				replacer,
			),
		);
	} catch (error) {
		console.log(
			JSON.stringify({ at: new Date().toISOString(), error: String(error) }),
		);
	}
	await new Promise((resolve) =>
		setTimeout(resolve, config.intervalSeconds * 1000),
	);
}
simulator.stop();
store.unlock();
