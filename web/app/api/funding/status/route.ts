import { isEvmAddress, readStatus } from "../../../../src/funding/intents.ts";
import { apiKey, oneClick } from "../../../../src/server/oneclick.ts";

export const dynamic = "force-dynamic";

/** Where a deposit to a quoted address is, as 1Click reports it. */
export async function GET(request: Request): Promise<Response> {
	const key = apiKey();
	if (!key) {
		return Response.json(
			{ error: "Adding dollars is not available right now." },
			{ status: 503 },
		);
	}
	const depositAddress = new URL(request.url).searchParams.get(
		"depositAddress",
	);
	if (!isEvmAddress(depositAddress)) {
		return Response.json({ error: "Unknown deposit." }, { status: 400 });
	}
	const answer = await oneClick(
		`/status?depositAddress=${depositAddress}`,
		{ method: "GET" },
		key,
	);
	const progress = answer.status < 300 ? readStatus(answer.body) : undefined;
	if (!progress) {
		return Response.json(
			{ error: "Could not read the deposit's progress." },
			{ status: 502 },
		);
	}
	return Response.json(progress);
}
