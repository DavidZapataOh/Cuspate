import { TESTNET } from "./record.ts";

/**
 * The endpoint the test network is read through: MONAD_TESTNET_RPC_URL where it is set (a fork, in
 * the browser tests), the network's public one otherwise. Read at request time, so one build serves
 * either.
 */
export function rpcUrl(): string {
	return (
		process.env.MONAD_TESTNET_RPC_URL ?? TESTNET.rpcUrls.default.http[0] ?? ""
	);
}
