/**
 * The wallet provider behind the sponsorship route. A session token is verified against the app's
 * key; the user's email wallet is looked up by the verified user, and created on their first
 * request, so a wallet is never named by the request. A batch is sent from that wallet with the gas
 * paid by the app, authorised by the user's own session token. The provider also keeps the
 * sponsorship tallies: each user's in that user's server-side metadata, which only the app's
 * secret can write, and everyone's in the metadata of one record that no one can sign in as.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { NotFoundError, PrivyClient, type User } from "@privy-io/node";
import { getAddress } from "viem";
import { TESTNET } from "../chain/record.ts";
import type { Tally, TallyKey, TallyStore } from "./limits.ts";
import {
	type SessionUser,
	type SponsoredStatus,
	type SponsorGateway,
	unavailable,
} from "./sponsor.ts";

type Metadata = Record<string, string | number | boolean>;

/** Where a tally sits in a metadata record: its period and its count. */
function fields(key: TallyKey): { period: string; count: string } {
	return key === "global"
		? { period: "sponsoredMonth", count: "sponsoredInMonth" }
		: { period: "sponsoredDay", count: "sponsoredInDay" };
}

/** The tally a metadata record holds, or nothing when it holds none that reads as one. */
export function tallyIn(metadata: Metadata, key: TallyKey): Tally | undefined {
	const { period, count } = fields(key);
	const p = metadata[period];
	const c = metadata[count];
	if (typeof p !== "string" || typeof c !== "number") return undefined;
	return { period: p, count: c };
}

/** A metadata record with a tally written into it, keeping every other entry. */
export function withTally(
	metadata: Metadata,
	key: TallyKey,
	tally: Tally,
): Metadata {
	const { period, count } = fields(key);
	return { ...metadata, [period]: tally.period, [count]: tally.count };
}

/**
 * The record that holds everyone's tally: a user with no email, phone or wallet, identified only
 * by an id under the app's custom sign-in, which is off, so it can never sign in.
 */
const LEDGER = "cuspate-sponsorship-ledger";

function clientOf(env: Record<string, string | undefined>) {
	const appId = env.NEXT_PUBLIC_PRIVY_APP_ID;
	const appSecret = env.PRIVY_APP_SECRET;
	if (!appId || !appSecret) return undefined;
	return new PrivyClient({ appId, appSecret });
}

/** The tallies in the provider's metadata, or nothing where the provider is not configured. */
export function privyTallies(
	env: Record<string, string | undefined> = process.env,
): TallyStore | undefined {
	const privy = clientOf(env);
	if (!privy) return undefined;
	const users = privy.users();

	/** The ledger record, created on first use; its lookup is never served from a cache. */
	async function ledger(): Promise<User> {
		try {
			return await users.getByCustomAuthID({ custom_user_id: LEDGER });
		} catch (error) {
			if (!(error instanceof NotFoundError)) throw error;
		}
		try {
			return await users.create({
				linked_accounts: [{ type: "custom_auth", custom_user_id: LEDGER }],
			});
		} catch {
			// Another request created it first.
			return await users.getByCustomAuthID({ custom_user_id: LEDGER });
		}
	}

	/**
	 * A user's record as it is now. Measured: the plain lookup by id answers from a cache for about
	 * ten seconds after a write, which would let a user's tally lag behind their batches; a lookup
	 * whose address has never been asked for before is answered fresh.
	 */
	const userNow = (id: string) =>
		users._get(id, { query: { fresh: randomUUID() } });

	const recordOf = (key: TallyKey) =>
		key === "global" ? ledger() : userNow(key.user);

	return {
		async read(key) {
			return tallyIn((await recordOf(key)).custom_metadata ?? {}, key);
		},
		async write(key, tally) {
			const record = await recordOf(key);
			await users.setCustomMetadata(record.id, {
				custom_metadata: withTally(record.custom_metadata ?? {}, key, tally),
			});
		},
	};
}

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
	const client = clientOf(env);
	if (!client) return unavailable;
	const privy = client;

	async function walletOf(userId: string): Promise<SessionUser> {
		for await (const wallet of privy
			.wallets()
			.list({ user_id: userId, chain_type: "ethereum" })) {
			return {
				userId,
				walletId: wallet.id,
				address: getAddress(wallet.address),
			};
		}
		const created = await privy
			.wallets()
			.create({ chain_type: "ethereum", owner: { user_id: userId } });
		return {
			userId,
			walletId: created.id,
			address: getAddress(created.address),
		};
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
			const sent = await privy.transactions().get(transactionId);
			return { status: statusOf(sent.status), walletId: sent.wallet_id };
		},
	};
}
