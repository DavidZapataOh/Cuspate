import { defineConfig, devices } from "@playwright/test";

// The three engines Playwright ships are the supported browsers. Each runs against the production
// build, served by the framework's own server, never against a development server. The server reads
// the committed deployment record's markets from the test network (and from the indexer where
// INDEXER_GRAPHQL_URL is set); each spec reads the same sources itself and expects what they hold.
// Buying is proven against a fork by e2e/fork/run.ts.
const port = 3107;

export default defineConfig({
	testDir: "e2e",
	// The purchase tests need a fork of the network and run from e2e/fork/run.ts.
	testIgnore: "fork/**",
	fullyParallel: true,
	// The public endpoint limits its rate; every worker reads it too.
	workers: 2,
	// The first read of the chain after the server starts can wait out the endpoint's rate limit.
	timeout: 60_000,
	forbidOnly: true,
	retries: 0,
	reporter: [["list"]],
	snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
	expect: {
		toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" },
	},
	use: { baseURL: `http://127.0.0.1:${port}` },
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
	webServer: {
		command: `next start --port ${port} --hostname 127.0.0.1`,
		url: `http://127.0.0.1:${port}/catalogue`,
		reuseExistingServer: false,
		env: {
			NEXT_TELEMETRY_DISABLED: "1",
			CUSPATE_CATALOGUE: "1",
		},
	},
});
