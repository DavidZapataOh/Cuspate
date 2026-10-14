/**
 * The wallet provider behind the sponsorship route. A session token is verified against the app's
 * key; the user's email wallet is looked up by the verified user, and created on their first
 * request, so a wallet is never named by the request. A batch is sent from that wallet with the gas
 * paid by the app, authorised by the user's own session token.
 */
import "server-only";
import { PrivyClient } from "@privy-io/node";
import { getAddress } from "viem";
import { TESTNET } from "../chain/record.ts";
import {
	type SessionUser,
	type SponsoredStatus,
	type SponsorGateway,
	unavailable,
} from "./sponsor.ts";

/** A provider transaction's state, as the route reports it. */
export function statusOf(state: string): SponsoredStatus {
	if (state === "confirmed" || state === "finalized") return "confirmed";
	if (
		state === "execution_reverted" ||
		state === "failed" ||
		state === "replaced" ||
		state === "provider_error"
	)
		return "failed";
	return "pending";
}

/**
 * The gateway for this deployment: connected when the app id and secret are set, `unavailable`
 * otherwise.
 */
export function privyGateway(
	env: Record<string, string | undefined> = process.env,
): SponsorGateway {
	const appId = env.NEXT_PUBLIC_PRIVY_APP_ID;
	const appSecret = env.PRIVY_APP_SECRET;
	if (!appId || !appSecret) return unavailable;
	const privy = new PrivyClient({ appId, appSecret });

	async function walletOf(userId: string): Promise<SessionUser> {
		for await (const wallet of privy
			.wallets()
			.list({ user_id: userId, chain_type: "ethereum" })) {
			return { walletId: wallet.id, address: getAddress(wallet.address) };
		}
		const created = await privy
			.wallets()
			.create({ chain_type: "ethereum", owner: { user_id: userId } });
		return { walletId: created.id, address: getAddress(created.address) };
	}

	return {
		async userOf(token) {
			let userId: string;
			try {
				userId = (await privy.utils().auth().verifyAccessToken(token)).user_id;
			} catch {
				return undefined;
			}
			return walletOf(userId);
		},
		async execute(walletId, calls, token) {
			const sent = await privy.wallets().rpc(walletId, {
				method: "wallet_sendCalls",
				caip2: `eip155:${TESTNET.id}`,
				sponsor: true,
				params: {
					calls: calls.map((call) => ({
						to: call.to,
						data: call.data,
						value: "0x0",
					})),
				},
				authorization_context: { user_jwts: [token] },
			});
			return { transactionId: sent.data.transaction_id };
		},
		async status(transactionId) {
			return statusOf((await privy.transactions().get(transactionId)).status);
		},
	};
}
