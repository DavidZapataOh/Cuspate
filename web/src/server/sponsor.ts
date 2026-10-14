/**
 * The server route that pays the gas of a signed-in user's purchase: it reads the user from the
 * verified session, never from the request; it sends only batches that buy on Cuspate or take the
 * test dollars; it runs the batch against the chain first, so a refusal is never paid for; and only
 * then asks the wallet provider to send it from the user's own wallet. The provider's part is behind
 * `SponsorGateway`; where it is not configured, `unavailable` refuses every request plainly.
 */
import "server-only";
import {
	type Address,
	decodeFunctionData,
	getAddress,
	type Hex,
	isAddress,
	isHex,
	parseAbi,
} from "viem";
import { contracts } from "../chain/record.ts";
import type { Call } from "../ticket/order.ts";
import { type Problem, problemText } from "../ticket/problems.ts";

/** The user a verified session belongs to, and the wallet the provider holds for them. */
export type SessionUser = { walletId: string; address: Address };

/** A sent batch's progress, as the provider reports it. */
export type SponsoredStatus = "pending" | "confirmed" | "failed";

/** What the wallet provider does for the route. */
export type SponsorGateway = {
	/** The user a session token proves, or nothing for a token that proves no one. */
	userOf(token: string): Promise<SessionUser | undefined>;
	/** Sends a batch from the user's wallet, gas paid, and names the transaction to follow. */
	execute(
		walletId: string,
		calls: Call[],
		token: string,
	): Promise<{ transactionId: string }>;
	status(transactionId: string): Promise<SponsoredStatus>;
};

/** The provider is not connected yet. */
export class SponsorUnavailable extends Error {}

/** The gateway before sign-in with an email is connected: it refuses everything. */
export const unavailable: SponsorGateway = {
	userOf: async () => {
		throw new SponsorUnavailable();
	},
	execute: async () => {
		throw new SponsorUnavailable();
	},
	status: async () => {
		throw new SponsorUnavailable();
	},
};

const abi = parseAbi([
	"function approve(address spender, uint256 amount) returns (bool)",
	"function enter(bytes32 marketId, bool yes, uint256 dollars, uint256 minShares, address recipient, uint256 deadline) returns (uint256)",
	"function drip()",
]);

/** The longest batch paid for: approvals and the purchase. */
const MAX_CALLS = 3;

type Wire = { to?: unknown; data?: unknown; value?: unknown };

function decoded(call: Wire) {
	try {
		return decodeFunctionData({ abi, data: call.data as Hex });
	} catch {
		return undefined;
	}
}

function same(a: unknown, b: Address): boolean {
	return typeof a === "string" && isAddress(a) && getAddress(a) === b;
}

/**
 * Why a batch is not one the server pays for, or nothing when it is: its last call buys through the
 * router or takes the test dollars' drip, every earlier call approves the router to take test
 * dollars, no call carries value, and it is short.
 */
export function batchRefusal(calls: Wire[]): string | undefined {
	if (calls.length === 0 || calls.length > MAX_CALLS) return "length";
	for (const call of calls) {
		if (String(call.value ?? "0") !== "0") return "value";
		if (!isHex(call.data)) return "data";
	}
	const last = calls[calls.length - 1] as Wire;
	const final = decoded(last);
	const buys =
		final?.functionName === "enter" && same(last.to, contracts.router);
	const drips =
		final?.functionName === "drip" && same(last.to, contracts.dollar);
	if (!buys && !drips) return "last call";
	for (const call of calls.slice(0, -1)) {
		const fn = decoded(call);
		if (
			fn?.functionName !== "approve" ||
			!same(call.to, contracts.dollar) ||
			!same(fn.args[0], contracts.router)
		)
			return "approval";
	}
	return undefined;
}

const UNAVAILABLE =
	"Email sign-in is not available right now. Connect a wallet to buy.";
const REFUSED =
	"Only purchases on Cuspate can be sent this way. Nothing was sent.";
const SIGN_IN = "Sign in to buy.";

function tokenOf(request: Request): string | undefined {
	const header = request.headers.get("authorization") ?? "";
	return /^Bearer (.+)$/.exec(header)?.[1];
}

async function userFor(
	request: Request,
	gateway: SponsorGateway,
): Promise<{ error: Response } | { user: SessionUser; token: string }> {
	const token = tokenOf(request);
	if (!token)
		return { error: Response.json({ message: SIGN_IN }, { status: 401 }) };
	const user = await gateway.userOf(token);
	if (!user)
		return { error: Response.json({ message: SIGN_IN }, { status: 401 }) };
	return { user, token };
}

function unavailableResponse(error: unknown): Response {
	if (error instanceof SponsorUnavailable)
		return Response.json({ message: UNAVAILABLE }, { status: 503 });
	throw error;
}

/**
 * Sends a signed-in user's batch, gas paid: the user from the session, the batch checked against
 * what is paid for and against the chain, then sent from the user's wallet.
 * @param simulate Runs the calls as the user would send them; a problem stops the request.
 */
export async function sponsorPost(
	request: Request,
	gateway: SponsorGateway,
	simulate: (account: Address, calls: Call[]) => Promise<Problem | undefined>,
): Promise<Response> {
	try {
		const found = await userFor(request, gateway);
		if ("error" in found) return found.error;
		const body = (await request.json().catch(() => ({}))) as {
			calls?: unknown;
		};
		const wire = Array.isArray(body.calls) ? (body.calls as Wire[]) : [];
		if (batchRefusal(wire))
			return Response.json({ message: REFUSED }, { status: 400 });
		const calls: Call[] = wire.map((c) => ({
			to: getAddress(String(c.to)),
			data: c.data as Hex,
			value: 0n,
		}));
		const problem = await simulate(found.user.address, calls);
		if (problem)
			return Response.json({ message: problemText(problem) }, { status: 400 });
		const sent = await gateway.execute(found.user.walletId, calls, found.token);
		return Response.json({ transactionId: sent.transactionId });
	} catch (error) {
		return unavailableResponse(error);
	}
}

/** How a sent batch is going, for the signed-in user who sent it. */
export async function sponsorStatus(
	request: Request,
	gateway: SponsorGateway,
): Promise<Response> {
	try {
		const found = await userFor(request, gateway);
		if ("error" in found) return found.error;
		const id = new URL(request.url).searchParams.get("id");
		if (!id)
			return Response.json(
				{ message: "No transaction named." },
				{ status: 400 },
			);
		return Response.json({ status: await gateway.status(id) });
	} catch (error) {
		return unavailableResponse(error);
	}
}

/** The wallet a signed-in session holds, for the browser to show and to read balances with. */
export async function sessionAccount(
	request: Request,
	gateway: SponsorGateway,
): Promise<Response> {
	try {
		const found = await userFor(request, gateway);
		if ("error" in found) return found.error;
		return Response.json({ address: found.user.address });
	} catch (error) {
		return unavailableResponse(error);
	}
}
