/**
 * The server route that pays the gas of a signed-in user's actions on Cuspate: it reads the user
 * from the verified session, never from the request; it sends only calls to Cuspate's own
 * contracts, whose arguments pay nothing to anyone but the session's wallet; it runs the batch
 * against the chain first, so a refusal is never paid for; it counts the batch against the user's
 * daily and everyone's monthly limit; and only then asks the wallet provider to send it from the
 * user's own wallet. The provider's part is behind `SponsorGateway`; where it is not configured,
 * `unavailable` refuses every request plainly.
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
import record from "../../../contracts/deployments/10143.json" with {
	type: "json",
};
import { contracts } from "../chain/record.ts";
import type { Call } from "../ticket/order.ts";
import { type Problem, problemText } from "../ticket/problems.ts";
import type { SponsorLimits } from "./limits.ts";

/** The user a verified session belongs to, and the wallet the provider holds for them. */
export type SessionUser = {
	userId: string;
	walletId: string;
	address: Address;
};

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
	/** A sent transaction's progress, and the wallet that sent it. */
	status(
		transactionId: string,
	): Promise<{ status: SponsoredStatus; walletId: string }>;
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

/** A market the deployment record holds: its id, its two vaults and their four tokens. */
export type RecordedMarket = {
	marketId: Hex;
	underlyingVault: Address;
	dollarVault: Address;
	legs: {
		underlyingYes: Address;
		underlyingNo: Address;
		dollarYes: Address;
		dollarNo: Address;
	};
};

function recordedAddress(value: unknown, where: string): Address {
	if (typeof value !== "string" || !isAddress(value))
		throw new Error(`${where}: not an address`);
	return getAddress(value);
}

/**
 * The markets of the deployment record, the only ones whose tokens and vaults are paid for.
 * @throws for a market recorded without its id, a vault or a token.
 */
export function marketsIn(book: {
	markets?: Record<string, unknown>;
}): RecordedMarket[] {
	return Object.entries(book.markets ?? {}).map(([key, value]) => {
		const entry = value as {
			marketId?: unknown;
			underlyingVault?: unknown;
			dollarVault?: unknown;
			legs?: Record<string, unknown>;
		};
		if (!isHex(entry.marketId) || entry.marketId.length !== 66)
			throw new Error(`${key}: no market id`);
		const legs = entry.legs ?? {};
		return {
			marketId: entry.marketId.toLowerCase() as Hex,
			underlyingVault: recordedAddress(entry.underlyingVault, key),
			dollarVault: recordedAddress(entry.dollarVault, key),
			legs: {
				underlyingYes: recordedAddress(legs.underlyingYes, key),
				underlyingNo: recordedAddress(legs.underlyingNo, key),
				dollarYes: recordedAddress(legs.dollarYes, key),
				dollarNo: recordedAddress(legs.dollarNo, key),
			},
		};
	});
}

/** The test network's recorded markets. */
export const recordedMarkets: readonly RecordedMarket[] = marketsIn(
	record as { markets?: Record<string, unknown> },
);

const abi = parseAbi([
	"function approve(address spender, uint256 amount) returns (bool)",
	"function enter(bytes32 marketId, bool yes, uint256 dollars, uint256 minShares, address recipient, uint256 deadline) returns (uint256)",
	"function exit((bytes32 marketId, bool yes, uint256 shares, uint256 kept, uint256 minOut, bool levelSellsWorldDollar, uint256 level, uint256 minLevelOut, address recipient, uint256 deadline) order) returns (uint256 dollars)",
	"function redeemPositions(uint256 yesAmount, uint256 noAmount)",
	"function drip()",
]);

/** The longest batch paid for: two approvals and an undo. */
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
	return (
		typeof a === "string" &&
		isAddress(a, { strict: false }) &&
		getAddress(a) === getAddress(b)
	);
}

/**
 * The tokens each approval in front of the last call may approve, all to the router: none, or the
 * tokens that call takes from the wallet. Each at most once.
 */
function approvalsRefusal(
	approvals: Wire[],
	tokens: Address[],
): string | undefined {
	const seen = new Set<Address>();
	for (const call of approvals) {
		const fn = decoded(call);
		if (fn?.functionName !== "approve" || !same(fn.args[0], contracts.router))
			return "approval";
		const token = tokens.find((t) => same(call.to, t));
		if (!token || seen.has(token)) return "approval";
		seen.add(token);
	}
	return undefined;
}

/**
 * Why a batch is not one the server pays for, or nothing when it is. Paid for, with no value on
 * any call, and nothing else:
 * - a purchase: an optional approval of the test dollar to the router, then the router's entry
 *   into a recorded market for the session's wallet;
 * - an undo: approvals to the router of the share and the kept dollar the exit takes, then the
 *   router's exit from that recorded market, paying the session's wallet;
 * - a redemption: each of a recorded market's vaults redeeming the caller's own legs, once;
 * - the test dollars' drip, alone.
 * @param wallet The session's wallet, the only recipient a purchase or an undo may name.
 */
export function batchRefusal(
	calls: Wire[],
	wallet: Address,
	markets: readonly RecordedMarket[] = recordedMarkets,
): string | undefined {
	if (calls.length === 0 || calls.length > MAX_CALLS) return "length";
	for (const call of calls) {
		if (String(call.value ?? "0") !== "0") return "value";
		if (!isHex(call.data)) return "data";
		if (!decoded(call)) return "call";
	}
	const marketOf = (id: unknown) =>
		markets.find(
			(m) => typeof id === "string" && m.marketId === id.toLowerCase(),
		);
	const last = calls[calls.length - 1] as Wire;
	const final = decoded(last);
	const before = calls.slice(0, -1);

	if (final?.functionName === "enter") {
		const [marketId, , , , recipient] = final.args;
		if (!same(last.to, contracts.router)) return "router";
		if (!marketOf(marketId)) return "market";
		if (!same(recipient, wallet)) return "recipient";
		return approvalsRefusal(before, [contracts.dollar]);
	}
	if (final?.functionName === "exit") {
		const [order] = final.args;
		const market = marketOf(order.marketId);
		if (!same(last.to, contracts.router)) return "router";
		if (!market) return "market";
		if (!same(order.recipient, wallet)) return "recipient";
		const { legs } = market;
		const taken = order.yes
			? [legs.underlyingYes, legs.dollarNo]
			: [legs.underlyingNo, legs.dollarYes];
		return approvalsRefusal(before, taken);
	}
	if (final?.functionName === "redeemPositions") {
		const vaults = markets.flatMap((m) => [m.underlyingVault, m.dollarVault]);
		const seen = new Set<Address>();
		for (const call of calls) {
			if (decoded(call)?.functionName !== "redeemPositions") return "redeem";
			const vault = vaults.find((v) => same(call.to, v));
			if (!vault || seen.has(vault)) return "vault";
			seen.add(vault);
		}
		return undefined;
	}
	if (final?.functionName === "drip") {
		if (calls.length !== 1 || !same(last.to, contracts.dollar)) return "drip";
		return undefined;
	}
	return "last call";
}

const UNAVAILABLE =
	"Email sign-in is not available right now. Connect a wallet to buy.";
const REFUSED =
	"Only buying, undoing, redeeming and taking test dollars on Cuspate can be sent this way, to your own wallet. Nothing was sent.";
const DAILY_LIMIT =
	"You've used today's free transactions. They reset at midnight UTC, or connect a wallet to pay your own gas. Nothing was sent.";
const MONTHLY_LIMIT =
	"This month's free transactions are used up. Connect a wallet to pay your own gas. Nothing was sent.";
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
 * what is paid for and against the chain, counted against the limits, then sent from the user's
 * wallet.
 * @param simulate Runs the calls as the user would send them; a problem stops the request.
 * @param limits Counts the batch, or names the limit it reached; asked only for a batch that would
 *        otherwise be sent, so a refused one never spends the user's allowance.
 */
export async function sponsorPost(
	request: Request,
	gateway: SponsorGateway,
	simulate: (account: Address, calls: Call[]) => Promise<Problem | undefined>,
	limits: SponsorLimits,
): Promise<Response> {
	try {
		const found = await userFor(request, gateway);
		if ("error" in found) return found.error;
		const body = (await request.json().catch(() => ({}))) as {
			calls?: unknown;
		};
		const wire = Array.isArray(body.calls) ? (body.calls as Wire[]) : [];
		if (batchRefusal(wire, found.user.address))
			return Response.json({ message: REFUSED }, { status: 403 });
		const calls: Call[] = wire.map((c) => ({
			to: getAddress(String(c.to)),
			data: c.data as Hex,
			value: 0n,
		}));
		const problem = await simulate(found.user.address, calls);
		if (problem)
			return Response.json({ message: problemText(problem) }, { status: 400 });
		const reached = await limits.reserve(found.user.userId);
		if (reached)
			return Response.json(
				{ message: reached === "user" ? DAILY_LIMIT : MONTHLY_LIMIT },
				{ status: 429 },
			);
		const sent = await gateway.execute(found.user.walletId, calls, found.token);
		return Response.json({ transactionId: sent.transactionId });
	} catch (error) {
		return unavailableResponse(error);
	}
}

/** How a sent batch is going, for the signed-in user who sent it and no one else. */
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
		const { status, walletId } = await gateway.status(id);
		if (walletId !== found.user.walletId)
			return Response.json(
				{ message: "No such transaction." },
				{ status: 404 },
			);
		return Response.json({ status });
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
