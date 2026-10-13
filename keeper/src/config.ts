/**
 * The keeper's settings, from the environment. The protocol's addresses are the deployment's; the
 * third parties it trades through are the production chain's, from the repository's address book.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import type { Deployment } from "./market.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

const book = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../contracts/deployments/143.json",
);

export type Config = ReturnType<typeof configFromEnv>;

export function configFromEnv(env: Record<string, string | undefined>) {
	const get = (name: string, pattern?: RegExp) => {
		const value = env[name];
		if (value === undefined || value === "")
			throw new Error(`${name} is not set`);
		if (pattern && !pattern.test(value))
			throw new Error(`${name} is malformed`);
		return value;
	};
	const positive = (name: string, fallback: string) => {
		const value = env[name] ?? fallback;
		if (!/^\d+$/.test(value) || BigInt(value) === 0n)
			throw new Error(`${name} must be a positive integer`);
		return BigInt(value);
	};
	const thirdParty = (
		JSON.parse(readFileSync(book, "utf8")) as {
			thirdParty: Record<string, Address[]>;
		}
	).thirdParty;
	const deployment: Deployment = {
		factory: get("CUSPATE_MARKET_FACTORY", ADDRESS) as Address,
		hook: get("CUSPATE_FREEZE_HOOK", ADDRESS) as Address,
		router: get("CUSPATE_POSITION_ROUTER", ADDRESS) as Address,
		stateView: thirdParty.stateView[0],
		quoter: thirdParty.v4Quoter[0],
		oracle: thirdParty.stockOracle[0],
		permit2: thirdParty.permit2[0],
		universalRouter: thirdParty.universalRouter[0],
	};
	return {
		rpcUrl: get("KEEPER_RPC_URL"),
		key: get("KEEPER_KEY", BYTES32) as Hex,
		safe: get("KEEPER_SAFE", ADDRESS) as Address,
		marketId: get("KEEPER_MARKET_ID", BYTES32) as Hex,
		eventId: get("KEEPER_EVENT_ID", BYTES32) as Hex,
		resolver: get("CUSPATE_RESOLVER", ADDRESS) as Address,
		stateDir: get("KEEPER_STATE_DIR"),
		multiSend: thirdParty.safeMultiSendCallOnly[0],
		deployment,
		intervalSeconds: Number(positive("KEEPER_INTERVAL_SECONDS", "30")),
		clip: positive("KEEPER_CLIP", ((1n << 256n) - 1n).toString()),
	};
}
