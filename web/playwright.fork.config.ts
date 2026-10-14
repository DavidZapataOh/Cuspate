import { defineConfig, devices } from "@playwright/test";

// The purchase tests, against a fork of the test network that e2e/fork/run.ts starts and names in
// the environment, served by the production build. One browser at a time: they buy from the same
// wallet on the same chain.
const port = 3108;

export default defineConfig({
	testDir: "e2e/fork",
	testMatch: "*.spec.ts",
	workers: 1,
	forbidOnly: true,
	retries: 0,
	timeout: 120_000,
	reporter: [["list"]],
	use: { baseURL: `http://127.0.0.1:${port}` },
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
	webServer: {
		command: `next start --port ${port} --hostname 127.0.0.1`,
		url: `http://127.0.0.1:${port}/`,
		reuseExistingServer: false,
		env: {
			NEXT_TELEMETRY_DISABLED: "1",
			MONAD_TESTNET_RPC_URL: process.env.MONAD_TESTNET_RPC_URL ?? "",
			CUSPATE_DEPLOYMENT_RECORD: process.env.CUSPATE_DEPLOYMENT_RECORD ?? "",
			INDEXER_GRAPHQL_URL: process.env.INDEXER_GRAPHQL_URL ?? "",
		},
	},
});
