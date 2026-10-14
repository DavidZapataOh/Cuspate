/**
 * The NEAR Intents 1Click service, called from the server only: its key is read from the
 * environment here and never reaches the browser.
 */
import "server-only";

const BASE = "https://1click.chaindefuser.com/v0";

/** The service's key, or nothing when the deployment has none. */
export function apiKey(): string | undefined {
	const key = process.env.NEAR_INTENTS_API_KEY?.trim();
	return key ? key : undefined;
}

/** Calls the service and returns its status and parsed body; a network failure reads as 502. */
export async function oneClick(
	path: string,
	init: { method: "GET" } | { method: "POST"; body: unknown },
	key: string,
): Promise<{ status: number; body: unknown }> {
	try {
		const response = await fetch(`${BASE}${path}`, {
			method: init.method,
			headers: {
				Authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: init.method === "POST" ? JSON.stringify(init.body) : undefined,
			cache: "no-store",
			signal: AbortSignal.timeout(60_000),
		});
		const body: unknown = await response.json().catch(() => undefined);
		return { status: response.status, body };
	} catch {
		return { status: 502, body: undefined };
	}
}

/** The service's own message for a refused request, when it gives one. */
export function serviceMessage(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const message = (body as { message?: unknown }).message;
	return typeof message === "string" ? message : undefined;
}
