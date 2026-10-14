import {
	isEvmAddress,
	quoteRequest,
	readQuote,
	sourceById,
	toBaseUnits,
} from "../../../../src/funding/intents.ts";
import {
	apiKey,
	oneClick,
	serviceMessage,
} from "../../../../src/server/oneclick.ts";

export const dynamic = "force-dynamic";

function refuse(status: number, error: string): Response {
	return Response.json({ error }, { status });
}

/** Asks 1Click for a deposit address that sends the chosen dollars to the given Monad address. */
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
