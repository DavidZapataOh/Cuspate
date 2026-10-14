import { rpcUrl } from "../../../src/chain/endpoint.ts";
import { chainClient, checkPurchase } from "../../../src/chain/market.ts";
import {
	type SponsorLimits,
	sponsorLimits,
} from "../../../src/server/limits.ts";
import { privyGateway, privyTallies } from "../../../src/server/privy.ts";
import {
	SponsorUnavailable,
	sponsorPost,
	unavailable,
} from "../../../src/server/sponsor.ts";

export const dynamic = "force-dynamic";

/** Without a store for the tallies nothing is paid for, rather than paying without limits. */
const unlimited: SponsorLimits = {
	reserve: async () => {
		throw new SponsorUnavailable();
	},
};

/**
 * Sends a signed-in user's action on Cuspate from their email wallet, gas paid, once it checks out
 * and is within the limits.
 */
export async function POST(request: Request): Promise<Response> {
	const tallies = privyTallies();
	return sponsorPost(
		request,
		tallies ? privyGateway() : unavailable,
		(account, calls) => checkPurchase(chainClient(rpcUrl()), account, calls),
		tallies ? sponsorLimits(tallies) : unlimited,
	);
}
