/**
 * The keeper as a service: every market it keeps, one step each every interval, then each market's
 * follow-ups and watchers, one line of JSON per step and per alert. Run with `node src/main.ts`; its
 * settings are in `config.ts`.
 *
 * The markets share one Safe, so one batch is in flight at a time: while a market's batch waits to be
 * mined, the round stops there, and no other market signs over the same Safe nonce.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { configFromEnv } from "./config.ts";
import { takeFollowUps } from "./followups.ts";
import { Keeper } from "./keeper.ts";
import { readMarket } from "./market.ts";
import { graceFor, logAlerts, watch } from "./monitor.ts";
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
const kept = [];
for (const { marketId, eventId, priceId } of config.markets) {
	const market = await readMarket(client, config.deployment, marketId, priceId);
	const keeper = new Keeper({
		client,
		wallet,
		owner,
		safe: config.safe,
		multiSend: config.multiSend,
		deployment: config.deployment,
		market,
		simulator,
		store,
		clip: config.clip,
		receiptTimeoutMs: 60_000,
	});
	kept.push({ market, eventId, keeper });
}

let running = true;
const stop = () => {
	running = false;
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

const replacer = (_: string, value: unknown) =>
	typeof value === "bigint" ? value.toString() : value;
while (running) {
	for (const { market, eventId, keeper } of kept) {
		if (!running) break;
		try {
			const step = await keeper.step();
			const followUps = await takeFollowUps(
				client,
				wallet,
				owner,
				config.resolver,
				eventId,
			);
			console.log(
				JSON.stringify(
					{
						at: new Date().toISOString(),
						market: market.marketId,
						step,
						followUps,
					},
					replacer,
				),
			);
			logAlerts(
				await watch(
					client,
					{ ...config.deployment, resolver: config.resolver },
					market,
					eventId,
					graceFor(config.intervalSeconds),
				),
			);
			if (step.kind === "waiting") break;
		} catch (error) {
			console.log(
				JSON.stringify({
					at: new Date().toISOString(),
					market: market.marketId,
					error: String(error),
				}),
			);
		}
	}
	await new Promise((resolve) =>
		setTimeout(resolve, config.intervalSeconds * 1000),
	);
}
simulator.stop();
store.unlock();
