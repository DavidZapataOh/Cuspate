import "server-only";
import { marketsOf } from "../data/book.ts";
import { deploymentRecord } from "../data/read.ts";
import type { Listed } from "./chain.ts";

/** Every market the deployment record lists, with the event, condition and issuer it belongs to. */
export function listedMarkets(): Listed[] {
	const record = deploymentRecord();
	const raw = (record.markets ?? {}) as Record<string, { issuer?: unknown }>;
	return [...marketsOf(record)].map(([key, market]) => {
		const [eventKey = key, conditionKey = ""] = key.split("/");
		const issuer =
			typeof raw[key]?.issuer === "string"
				? (raw[key].issuer as string)
				: (eventKey.split("-")[0] ?? "").toUpperCase();
		return { eventKey, conditionKey, issuer, market };
	});
}
