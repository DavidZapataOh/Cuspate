/**
 * Where the keeper tries a batch before it signs one. The production chain serves no multi-call
 * simulation, so the keeper keeps a local node forking the chain, resets it to the chain's head before
 * each sizing, and runs each candidate batch there as its account, on a snapshot it then discards.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
	type Address,
	createTestClient,
	http,
	type PublicClient,
	publicActions,
	walletActions,
} from "viem";
import type { Call } from "./correction.ts";

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address
					? resolve(address.port)
					: reject(new Error("no port")),
			);
		});
	});
}

/** A local fork of `upstream`, reset to its head on demand. */
export type Simulator = Awaited<ReturnType<typeof startSimulator>>;

export async function startSimulator(upstream: string) {
	const port = await freePort();
	const node: ChildProcess = spawn(
		"anvil",
		["--port", String(port), "--fork-url", upstream, "--silent"],
		{ stdio: "ignore" },
	);
	const url = `http://127.0.0.1:${port}`;
	const client = createTestClient({ mode: "anvil", transport: http(url) })
		.extend(publicActions)
		.extend(walletActions);
	for (let attempt = 0; ; attempt++) {
		try {
			await client.getChainId();
			break;
		} catch (error) {
			if (attempt > 120) {
				node.kill();
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	return {
		/** The fork, as a reader: what the implied price is read from after a batch. */
		reader: client as unknown as PublicClient,
		stop: () => node.kill(),
		/** Moves the fork to the upstream chain's current head. */
		async reset() {
			await client.reset({ jsonRpcUrl: upstream });
		},
		/**
		 * Runs a batch as `account` on a snapshot, reads `measure` after it, and discards it: the
		 * measure, or null if any call of the batch would revert.
		 */
		async tryBatch<T>(
			account: Address,
			calls: Call[],
			measure: (reader: PublicClient) => Promise<T>,
		): Promise<T | null> {
			const snapshot = await client.snapshot();
			try {
				await client.impersonateAccount({ address: account });
				await client.setBalance({ address: account, value: 10n ** 22n });
				for (const c of calls) {
					const hash = await client.sendTransaction({
						account,
						to: c.to,
						data: c.data,
						chain: null,
					});
					if (
						(await client.waitForTransactionReceipt({ hash })).status !==
						"success"
					)
						return null;
				}
				return await measure(client as unknown as PublicClient);
			} catch {
				return null;
			} finally {
				await client.revert({ id: snapshot });
				await client.stopImpersonatingAccount({ address: account });
			}
		},
	};
}
