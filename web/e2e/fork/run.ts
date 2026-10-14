/**
 * Runs the purchase tests: starts a fork of the test network, opens the featured condition's
 * market on it, funds the buyer, writes a deployment record that lists the market, and serves the
 * production build against the fork while the browsers buy.
 *
 *   node web/e2e/fork/run.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contracts } from "../../src/chain/record.ts";
import { fixtures } from "../../src/data/fixtures.ts";
import { BUYER, openMarket, startTestnetFork } from "./testnet.ts";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const committed = path.resolve(web, "../contracts/deployments/10143.json");

/** The event and condition the tests buy: the homepage's featured one. */
export const BOUGHT = { eventKey: "meta-q3-2026", conditionKey: "above-6-39" };

const fork = await startTestnetFork();
const dir = mkdtempSync(path.join(tmpdir(), "cuspate-fork-"));
let status = 1;
try {
	const event = await fixtures.event(BOUGHT.eventKey, Date.now());
	const condition = event?.conditions.find(
		(c) => c.key === BOUGHT.conditionKey,
	);
	if (!event || !condition) throw new Error("the featured condition is gone");
	const opened = await openMarket(fork, {
		...BOUGHT,
		ticker: event.issuer,
		period: event.period as { quarter: 1 | 2 | 3 | 4; fiscalYear: number },
		threshold: condition.threshold,
		announcesAt: event.announcesAt,
		yesWorldPriceCents: condition.yesWorldPriceCents,
		noWorldPriceCents: condition.noWorldPriceCents,
	});
	await fork.fund(contracts.dollar, BUYER, 10_000n * 10n ** 6n);
	const record = JSON.parse(readFileSync(committed, "utf8"));
	record.markets = { ...(record.markets ?? {}), [opened.key]: opened.binding };
	const file = path.join(dir, "10143.json");
	writeFileSync(file, JSON.stringify(record, null, 2));
	const result = spawnSync(
		"pnpm",
		["exec", "playwright", "test", "--config", "playwright.fork.config.ts"],
		{
			cwd: web,
			stdio: "inherit",
			env: {
				...process.env,
				MONAD_TESTNET_RPC_URL: fork.url,
				CUSPATE_DEPLOYMENT_RECORD: file,
			},
		},
	);
	status = result.status ?? 1;
} finally {
	fork.stop();
	rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
