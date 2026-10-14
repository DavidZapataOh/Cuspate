import { privyGateway } from "../../../src/server/privy.ts";
import { sessionAccount } from "../../../src/server/sponsor.ts";

export const dynamic = "force-dynamic";

/** The email wallet a signed-in session holds, created on the first sign-in. */
export async function GET(request: Request): Promise<Response> {
	return sessionAccount(request, privyGateway());
}
