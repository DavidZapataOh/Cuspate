import { defineConfig, devices } from "@playwright/test";

// The three engines Playwright ships are the supported browsers. Each runs against the production
// build, served by the framework's own server, never against a development server.
const port = 3107;

export default defineConfig({
	testDir: "e2e",
	fullyParallel: true,
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
		env: { NEXT_TELEMETRY_DISABLED: "1" },
	},
});
