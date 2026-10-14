import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { keccak256, toBytes } from "viem";
import { describe, expect, test } from "vitest";
import { configFromEnv } from "../src/config.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const env = {
	KEEPER_RPC_URL: "http://127.0.0.1:8545",
	KEEPER_KEY: `0x${"11".repeat(32)}`,
	KEEPER_SAFE: A(1),
	KEEPER_MARKET_ID: `0x${"22".repeat(32)}`,
	KEEPER_EVENT_ID: `0x${"33".repeat(32)}`,
	KEEPER_SYMBOL: "MU",
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
		expect(config.deployment.universalRouterMinHopPrice).toBe(false);
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

	test("keeps one market by default, priced by its own symbol", () => {
		const config = configFromEnv({ ...env, KEEPER_SYMBOL: "TSLA" });
		expect(config.markets).toEqual([
			{
				marketId: env.KEEPER_MARKET_ID,
				eventId: env.KEEPER_EVENT_ID,
				priceId: keccak256(toBytes("TSLA")),
			},
		]);
		expect(() => configFromEnv({ ...env, KEEPER_SYMBOL: "tsla" })).toThrow(
			"KEEPER_SYMBOL",
		);
	});

	test("keeps every market a generated file lists, in place of the single one", () => {
		const file = path.join(
			mkdtempSync(path.join(tmpdir(), "keeper-")),
			"m.json",
		);
		const one = {
			marketId: `0x${"44".repeat(32)}`,
			eventId: `0x${"55".repeat(32)}`,
			symbol: "META",
		};
		writeFileSync(file, JSON.stringify({ chainId: 143, markets: [one] }));
		const config = configFromEnv({
			...env,
			KEEPER_MARKET_ID: undefined,
			KEEPER_EVENT_ID: undefined,
			KEEPER_SYMBOL: undefined,
			KEEPER_MARKETS_FILE: file,
		});
		expect(config.markets).toEqual([
			{
				marketId: one.marketId,
				eventId: one.eventId,
				priceId: keccak256(toBytes("META")),
			},
		]);
		writeFileSync(file, JSON.stringify({ chainId: 10143, markets: [one] }));
		expect(() => configFromEnv({ ...env, KEEPER_MARKETS_FILE: file })).toThrow(
			"KEEPER_CHAIN",
		);
	});

	test("on the test network, trades through its third parties and reads its own feed", () => {
		const config = configFromEnv({ ...env, KEEPER_CHAIN: "10143" });
		expect(config.chainId).toBe(10143);
		expect(config.deployment.universalRouter).toBe(
			"0x1b7bFCd2870329B987191910D85c22C7287f3c22",
		);
		expect(config.deployment.oracle).toBe(
			"0x4CB07861A30785257eD9BB7aAbA8Cc90DCa90F24",
		);
		expect(config.multiSend).toBe("0x9641d764fc13c8B624c04430C7356C1C7C8102e2");
		expect(config.deployment.universalRouterMinHopPrice).toBe(true);
		expect(() => configFromEnv({ ...env, KEEPER_CHAIN: "1" })).toThrow(
			"KEEPER_CHAIN",
		);
	});
});
