/**
 * What the browser specs compare the pages with: the same read layer the server renders from,
 * instantiated in the test's own process over the committed deployment record and the same network
 * endpoint, so every number a spec expects is read from the chain (and the indexer, where
 * INDEXER_GRAPHQL_URL is set), never written into the spec.
 */
import record from "../../contracts/deployments/10143.json" with {
	type: "json",
};
import { sharedChainLayer } from "../src/data/chain.ts";

/** The read layer, as the server sees it. */
export const read = sharedChainLayer(
	record as unknown as Parameters<typeof sharedChainLayer>[0],
);

/** Whether the indexer is configured: without it the chance history shows only its two ends. */
export const indexed = Boolean(process.env.INDEXER_GRAPHQL_URL);
