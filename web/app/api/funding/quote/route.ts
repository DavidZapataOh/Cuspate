import { getAddress, type Hex, isHex } from "viem";
import { rpcUrl } from "../../../../src/chain/endpoint.ts";
import { chainClient } from "../../../../src/chain/market.ts";
import {
	isEvmAddress,
	quoteRequest,
	readQuote,
	sourceById,
	toBaseUnits,
} from "../../../../src/funding/intents.ts";
import {
	freshProof,
	proofMessage,
	takeSlot,
} from "../../../../src/funding/proof.ts";
import {
	apiKey,
	oneClick,
	serviceMessage,
} from "../../../../src/server/oneclick.ts";
import { privyGateway } from "../../../../src/server/privy.ts";

/** When each address took its recent deposit addresses, on this server. */
const taken = new Map<string, number[]>();

/**
 * Whether the request proves it comes from `address`: an email session's token for the wallet the
 * provider holds at that address, or that address's signature over the request's message.
 */
async function provenBy(
	request: Request,
	address: string,
	input: Record<string, unknown>,
): Promise<boolean> {
	const token = request.headers
		.get("authorization")
		?.match(/^Bearer (.+)$/)?.[1];
	if (token) {
		const user = await privyGateway()
			.userOf(token)
			.catch(() => undefined);
		return user !== undefined && user.address === getAddress(address);
	}
	const { signature, signedAt } = input;
	if (!isHex(signature) || typeof signedAt !== "number") return false;
	if (!freshProof(signedAt, Date.now())) return false;
	return chainClient(rpcUrl())
		.verifyMessage({
			address: getAddress(address),
			message: proofMessage(address, signedAt),
			signature: signature as Hex,
		})
		.catch(() => false);
}

export const dynamic = "force-dynamic";

function refuse(status: number, error: string): Response {
	return Response.json({ error }, { status });
}

/**
 * Asks 1Click for a deposit address that sends the chosen dollars to the given Monad address, for a
 * caller who proves it holds that address, a few times per address in each window.
 */
export async function POST(request: Request): Promise<Response> {
	const key = apiKey();
	if (!key) return refuse(503, "Adding dollars is not available right now.");
	const input: unknown = await request.json().catch(() => undefined);
	if (typeof input !== "object" || input === null) {
		return refuse(400, "The request could not be read.");
	}
	const {
		source: sourceId,
		amount,
		address,
	} = input as Record<string, unknown>;
	const source =
		typeof sourceId === "string" ? sourceById(sourceId) : undefined;
	if (!source) return refuse(400, "Choose where the dollars come from.");
	if (!isEvmAddress(address)) return refuse(400, "Sign in first.");
	if (!(await provenBy(request, address, input as Record<string, unknown>)))
		return refuse(401, "Sign in as this address first.");
	const slot = takeSlot(taken, address, Date.now());
	if (!slot.ok)
		return refuse(
			429,
			`Too many deposit addresses for this address. Try again after ${new Date(slot.retryAt).toISOString().slice(11, 16)} UTC.`,
		);
	if (typeof amount !== "string") return refuse(400, "Enter an amount.");
	const parsed = toBaseUnits(amount, source.decimals);
	if ("error" in parsed) return refuse(400, parsed.error);
	const answer = await oneClick(
		"/quote",
		{
			method: "POST",
			body: quoteRequest(source, parsed.units, address, Date.now()),
		},
		key,
	);
	const quote = answer.status < 300 ? readQuote(answer.body) : undefined;
	if (!quote) {
		const message = serviceMessage(answer.body);
		return refuse(
			502,
			message
				? `No quote: ${message}`
				: "No quote right now. Try again in a minute.",
		);
	}
	return Response.json(quote);
}
