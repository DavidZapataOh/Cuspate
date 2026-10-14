/**
 * Signing in with an email, against the wallet provider's sign-in service: a code is sent to the
 * address, and the code is exchanged for a session token. The token is all the browser keeps; the
 * wallet it opens is looked up by the server.
 */

const AUTH = "https://auth.privy.io/api/v1";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function headers(appId: string) {
	return { "privy-app-id": appId, "content-type": "application/json" };
}

/** Sends a sign-in code to the address. */
export async function sendCode(
	appId: string,
	email: string,
	fetcher: Fetcher = fetch,
): Promise<void> {
	const response = await fetcher(`${AUTH}/passwordless/init`, {
		method: "POST",
		headers: headers(appId),
		body: JSON.stringify({ email }),
	});
	if (!response.ok)
		throw new Error("The code could not be sent. Check the address.");
}

/** Exchanges the code for a session token. */
export async function verifyCode(
	appId: string,
	email: string,
	code: string,
	fetcher: Fetcher = fetch,
): Promise<string> {
	const response = await fetcher(`${AUTH}/passwordless/authenticate`, {
		method: "POST",
		headers: headers(appId),
		body: JSON.stringify({ email, code, mode: "login-or-sign-up" }),
	});
	const body = (await response.json().catch(() => ({}))) as {
		token?: string;
	};
	if (!response.ok || !body.token)
		throw new Error("That code did not work. Check it, or send a new one.");
	return body.token;
}

/** When a session token stops being accepted, in milliseconds, or 0 for one that cannot be read. */
export function expiryOf(token: string): number {
	try {
		const part = token.split(".")[1] ?? "";
		const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
		const exp = (JSON.parse(json) as { exp?: number }).exp;
		return typeof exp === "number" ? exp * 1000 : 0;
	} catch {
		return 0;
	}
}
