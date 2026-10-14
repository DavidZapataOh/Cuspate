import { rpcUrl } from "../../../src/chain/endpoint.ts";
import { chainClient, checkPurchase } from "../../../src/chain/market.ts";
import { privyGateway } from "../../../src/server/privy.ts";
import { sponsorPost } from "../../../src/server/sponsor.ts";

export const dynamic = "force-dynamic";

/** Sends a signed-in user's purchase from their email wallet, gas paid, once it checks out. */
export async function POST(request: Request): Promise<Response> {
	return sponsorPost(request, privyGateway(), (account, calls) =>
		checkPurchase(chainClient(rpcUrl()), account, calls),
	);
}
