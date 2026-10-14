import { rpcUrl } from "../../../src/chain/endpoint.ts";
import { chainClient, checkPurchase } from "../../../src/chain/market.ts";
import { sponsorPost, unavailable } from "../../../src/server/sponsor.ts";

export const dynamic = "force-dynamic";

/** Sends a signed-in user's purchase from their email wallet, gas paid, once it checks out. */
export async function POST(request: Request): Promise<Response> {
	return sponsorPost(request, unavailable, (account, calls) =>
		checkPurchase(chainClient(rpcUrl()), account, calls),
	);
}
