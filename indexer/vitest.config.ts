import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// A markets rehearsal runs its own reconciliation, against its fork, with its own configuration.
		exclude: ["**/node_modules/**", "test/rehearsal/**"],
		testTimeout: 600_000,
		hookTimeout: 600_000,
	},
});
