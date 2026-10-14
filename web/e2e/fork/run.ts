/**
 * Runs the purchase tests: starts a fork of the test network, funds the buyer, and serves the
 * production build against the fork while the browsers buy in the featured condition's market, the
 * one the network itself opened and the committed deployment record lists.
 *
 *   node web/e2e/fork/run.ts
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contracts } from "../../src/chain/record.ts";
import { BUYER, startTestnetFork } from "./testnet.ts";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const committed = path.resolve(web, "../contracts/deployments/10143.json");

/** The event and condition the tests buy: the homepage's featured one. */
export const BOUGHT = { eventKey: "meta-q3-2026", conditionKey: "above-6-39" };

const fork = await startTestnetFork();
let status = 1;
try {
	await fork.fund(contracts.dollar, BUYER, 10_000n * 10n ** 6n);
	const result = spawnSync(
		"pnpm",
		["exec", "playwright", "test", "--config", "playwright.fork.config.ts"],
		{
			cwd: web,
			stdio: "inherit",
			env: {
				...process.env,
				MONAD_TESTNET_RPC_URL: fork.url,
				CUSPATE_DEPLOYMENT_RECORD: committed,
				// The fork has no indexer: the pages read the markets from the fork itself.
				INDEXER_GRAPHQL_URL: "",
			},
		},
	);
	status = result.status ?? 1;
} finally {
	fork.stop();
}
process.exit(status);
