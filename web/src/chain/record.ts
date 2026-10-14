/**
 * The test network's contracts, read by their logical names from the deployment record the
 * deployment wrote from its receipts, so the interface can never point at an address the record
 * does not hold.
 */
import { type Address, getAddress } from "viem";
import { monadTestnet } from "viem/chains";
import record from "../../../contracts/deployments/10143.json" with {
	type: "json",
};

/** The network the markets run on today. */
export const TESTNET = monadTestnet;

type Entry = { address: string };
const entries = record as unknown as Record<string, Entry> & {
	thirdParty: Record<string, string[]>;
};

function named(name: string): Address {
	const entry = entries[name];
	if (!entry?.address) throw new Error(`no ${name} in the deployment record`);
	return getAddress(entry.address);
}

function thirdParty(name: string): Address {
	const address = entries.thirdParty[name]?.[0];
	if (!address) throw new Error(`no ${name} in the deployment record`);
	return getAddress(address);
}

/** The contracts a purchase touches. */
export const contracts = {
	router: named("PositionRouter"),
	factory: named("MarketFactory"),
	hook: named("FreezeHook"),
	dollar: named("TestnetDollar"),
	quoter: thirdParty("v4Quoter"),
} as const;

/**
 * The test network's stand-in for a company's stock.
 * @throws for a ticker the record holds no stock for.
 */
export function stockOf(ticker: string): Address {
	return named(`TestnetStock.${ticker}`);
}
