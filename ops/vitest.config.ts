import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { testTimeout: 1_200_000, hookTimeout: 1_200_000 },
});
