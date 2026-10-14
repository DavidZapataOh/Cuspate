import record from "../../../contracts/deployments/10143.json" with {
	type: "json",
};

/** The block explorer of the test network, for addresses and transactions. */
export const EXPLORER = "https://testnet.monadexplorer.com";

/** An address's page on the test network's explorer. */
export function addressUrl(address: string): string {
	return `${EXPLORER}/address/${address}`;
}

/** A transaction's page on the test network's explorer. */
export function txUrl(hash: string): string {
	return `${EXPLORER}/tx/${hash}`;
}

/** An address shortened for reading: "0x1234...abcd". */
export function short(hex: string): string {
	return `${hex.slice(0, 6)}...${hex.slice(-4)}`;
}

/** An account of the deployment with a named role, what it may do, and who controls it. */
export type Key = {
	role: string;
	can: string;
	address: string;
	txHash: string;
	owners: string[];
	threshold: number;
};

const POWERS: Record<string, string> = {
	sealer:
		"Seals each event's thresholds before it opens. Once sealed, a threshold cannot be changed by anyone, the sealer included.",
	guardian:
		"Can bring a market's freeze forward to now, stopping new purchases and undos, if something breaks. It cannot move money or change an outcome.",
	arbiter:
		"Rules on a challenged figure, or rules the event invalid. If it does not rule within its time limit, the event resolves invalid and every holder gets half of what they hold in each world: half the shares and half the dollars kept beside them.",
	treasury:
		"Receives the bonds that settled proposals leave behind. It holds no one's position.",
	keeper:
		"Our own trading account. While the stock's price feed is fresh (published within the last 25 minutes) and the market is not frozen, it trades in the pools whenever a market's implied share price drifts more than 1% below the feed's bid or above its ask; when the feed is older, as outside market hours, it does nothing. It also makes the routine calls anyone may make. The contracts give it no special power.",
};

type RoleRecord = {
	address: string;
	txHash: string;
	owners: string[];
	threshold: number;
};

/** The deployment's privileged accounts, as recorded when they were created on chain. */
export function keys(): Key[] {
	const roles = (record as { roles?: Record<string, RoleRecord> }).roles ?? {};
	return Object.entries(POWERS)
		.filter(([role]) => roles[role])
		.map(([role, can]) => {
			const r = roles[role] as RoleRecord;
			return {
				role,
				can,
				address: r.address,
				txHash: r.txHash,
				owners: r.owners,
				threshold: r.threshold,
			};
		});
}

/** The deployed contracts a visitor may want to inspect, by what they do. */
export function contracts(): {
	name: string;
	address: string;
	txHash: string;
}[] {
	const r = record as unknown as Record<
		string,
		{ address?: string; txHash?: string }
	>;
	const named: [string, string][] = [
		["ThresholdRegistry", "Sealed thresholds (no owner, cannot be edited)"],
		["OptimisticResolver", "Proposals, challenges and outcomes"],
		["FreezeHook", "The freeze at the announcement"],
		["MarketFactory", "Creates each market"],
		["PositionRouter", "Buys and undos"],
		["TestnetDollar", "The test dollar"],
	];
	return named.flatMap(([key, name]) => {
		const c = r[key];
		return c?.address && c.txHash
			? [{ name, address: c.address, txHash: c.txHash }]
			: [];
	});
}
