import { privyGateway } from "../../../../src/server/privy.ts";
import { sponsorStatus } from "../../../../src/server/sponsor.ts";

export const dynamic = "force-dynamic";

/** How a purchase sent through the server is going. */
export async function GET(request: Request): Promise<Response> {
	return sponsorStatus(request, privyGateway());
}
