/**
 * How a purchase is sent, behind one shape for the ticket: from a wallet the buyer connected, which
 * signs and pays its own gas, or through the server route, which sends it from the buyer's email
 * wallet with the gas paid and names a transaction to follow.
 */

import type { Address } from "viem";
import type { Config } from "wagmi";
import { sendCalls, waitForCallsStatus } from "wagmi/actions";
import { TESTNET } from "../chain/record.ts";
import type { Call } from "./order.ts";

/** A batch handed over to be sent, by the id that follows it. */
export type Submitted = { id: string };

/** How a sent batch ended. */
export type Settled = { status: "confirmed" | "failed" };

/** Sends a purchase's calls and follows them until they land or fail. */
export type Executor = {
	send(calls: Call[]): Promise<Submitted>;
	settle(submitted: Submitted): Promise<Settled>;
};

/**
 * A connected wallet: the calls as one batch where the wallet can, one after another where it
 * cannot, signed and paid by the wallet.
 */
export function walletExecutor(config: Config, account: Address): Executor {
	return {
		async send(calls) {
			const { id } = await sendCalls(config, {
				account,
				chainId: TESTNET.id,
				calls,
				experimental_fallback: true,
			});
			return { id };
		},
		async settle({ id }) {
			const { status } = await waitForCallsStatus(config, { id });
			return { status: status === "success" ? "confirmed" : "failed" };
		},
	};
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** The email wallet, through the server route, which pays the gas. */
export function sponsoredExecutor({
	token,
	fetcher = fetch,
	pollMs = 1_000,
	timeoutMs = 60_000,
}: {
	/** The signed-in session's token, which the route verifies. */
	token: () => Promise<string>;
	fetcher?: Fetcher;
	pollMs?: number;
	timeoutMs?: number;
}): Executor {
	const headers = async () => ({
		authorization: `Bearer ${await token()}`,
		"content-type": "application/json",
	});
	return {
		async send(calls) {
			const response = await fetcher("/api/sponsor", {
				method: "POST",
				headers: await headers(),
				body: JSON.stringify({
					calls: calls.map((c) => ({
						to: c.to,
						data: c.data,
						value: c.value.toString(),
					})),
				}),
			});
			const body = (await response.json()) as {
				transactionId?: string;
				message?: string;
			};
			if (!response.ok || !body.transactionId)
				throw new Error(
					body.message ??
						"That didn't go through, and nothing moved. Try again.",
				);
			return { id: body.transactionId };
		},
		async settle({ id }) {
			const until = Date.now() + timeoutMs;
			while (Date.now() < until) {
				const response = await fetcher(
					`/api/sponsor/status?id=${encodeURIComponent(id)}`,
					{ headers: await headers() },
				);
				const { status } = (await response.json()) as { status?: string };
				if (status === "confirmed" || status === "failed") return { status };
				await new Promise((resolve) => setTimeout(resolve, pollMs));
			}
			return { status: "failed" };
		},
	};
}
