import { describe, expect, test } from "vitest";
import { configFromEnv } from "../src/config.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const env = {
	KEEPER_RPC_URL: "http://127.0.0.1:8545",
	KEEPER_KEY: `0x${"11".repeat(32)}`,
	KEEPER_SAFE: A(1),
	KEEPER_MARKET_ID: `0x${"22".repeat(32)}`,
	KEEPER_EVENT_ID: `0x${"33".repeat(32)}`,
	KEEPER_STATE_DIR: "/tmp/keeper",
	CUSPATE_MARKET_FACTORY: A(2),
	CUSPATE_FREEZE_HOOK: A(3),
	CUSPATE_POSITION_ROUTER: A(4),
	CUSPATE_RESOLVER: A(5),
};

describe("the keeper's configuration", () => {
	test("is read from the environment, with the production chain's third parties from the address book", () => {
		const config = configFromEnv(env);
		expect(config.safe).toBe(A(1));
		expect(config.deployment.factory).toBe(A(2));
		expect(config.deployment.stateView).toMatch(/^0x[0-9a-fA-F]{40}$/);
		expect(config.multiSend).toMatch(/^0x[0-9a-fA-F]{40}$/);
		expect(config.intervalSeconds).toBe(30);
		expect(config.clip).toBe((1n << 256n) - 1n);
	});

	test("refuses to start without a setting it needs, naming it", () => {
		for (const name of Object.keys(env)) {
			const missing = { ...env, [name]: undefined };
			expect(() => configFromEnv(missing)).toThrow(name);
		}
	});

	test("refuses malformed addresses, ids and keys", () => {
		expect(() => configFromEnv({ ...env, KEEPER_SAFE: "0x1234" })).toThrow(
			"KEEPER_SAFE",
		);
		expect(() => configFromEnv({ ...env, KEEPER_MARKET_ID: "0x12" })).toThrow(
			"KEEPER_MARKET_ID",
		);
		expect(() => configFromEnv({ ...env, KEEPER_KEY: "0x12" })).toThrow(
			"KEEPER_KEY",
		);
		expect(() =>
			configFromEnv({ ...env, KEEPER_INTERVAL_SECONDS: "0" }),
		).toThrow("KEEPER_INTERVAL_SECONDS");
		expect(() => configFromEnv({ ...env, KEEPER_CLIP: "-1" })).toThrow(
			"KEEPER_CLIP",
		);
	});
});
