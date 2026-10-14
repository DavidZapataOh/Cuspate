import { readFileSync } from "node:fs";
import record from "../../../contracts/deployments/10143.json" with {
	type: "json",
};
import { marketsOf, withMarkets } from "./book.ts";
import { fixtures } from "./fixtures.ts";
import type { ReadLayer } from "./model.ts";

/**
 * The deployment record whose markets the pages bind: the committed one, or the one named by
 * CUSPATE_DEPLOYMENT_RECORD, which a rehearsal on a fork writes for its own markets.
 */
export function deploymentRecord(): { markets?: Record<string, unknown> } {
	const file = process.env.CUSPATE_DEPLOYMENT_RECORD;
	return file
		? JSON.parse(readFileSync(file, "utf8"))
		: (record as { markets?: Record<string, unknown> });
}

/**
 * The read layer the pages use. The events and their numbers are the synthetic fixtures until the
 * adapter over the indexer replaces them here; each condition carries its market wherever the
 * deployment record lists one, so its ticket buys on chain.
 */
export function readLayer(): ReadLayer {
	return withMarkets(fixtures, marketsOf(deploymentRecord()));
}
