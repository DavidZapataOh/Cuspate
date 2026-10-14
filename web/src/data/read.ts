import { readFileSync } from "node:fs";
import record from "../../../contracts/deployments/10143.json" with {
	type: "json",
};
import { sharedChainLayer } from "./chain.ts";
import type { ReadLayer } from "./model.ts";

/**
 * The deployment record whose markets the pages read: the committed one, or the one named by
 * CUSPATE_DEPLOYMENT_RECORD, which a rehearsal on a fork writes for its own markets.
 */
export function deploymentRecord(): { markets?: Record<string, unknown> } {
	const file = process.env.CUSPATE_DEPLOYMENT_RECORD;
	return file
		? JSON.parse(readFileSync(file, "utf8"))
		: (record as { markets?: Record<string, unknown> });
}

/**
 * The read layer the pages use: the markets the deployment record lists, every number read from the
 * test network.
 */
export function readLayer(): ReadLayer {
	return sharedChainLayer(
		deploymentRecord() as Parameters<typeof sharedChainLayer>[0],
	);
}
