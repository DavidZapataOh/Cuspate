import { defineConfig } from "vitest/config";

// The reconciliation a markets rehearsal runs, against its own fork: never part of the suite.
export default defineConfig({
	test: {
		include: ["test/rehearsal/**/*.test.ts"],
		testTimeout: 600_000,
		hookTimeout: 600_000,
	},
});
