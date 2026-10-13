/**
 * The ordered deployment of one network, every address predicted before anything is sent: the role
 * Safes, then on the test network its test contracts, then the protocol in dependency order.
 */
import { createHash } from "node:crypto";
import {
	type Address,
	concat,
	encodeDeployData,
	type Hex,
	stringToHex,
} from "viem";
import { artifact } from "./artifacts.ts";
import { CREATE2_DEPLOYER, mineHookSalt, predict, saltOf } from "./create2.ts";
import { createProxyData, predictSafe, setupData } from "./safe.ts";

/** The chains test contracts may exist on: the public test network and a local chain. */
export const TEST_CHAINS = [10143, 31337];

/** The roles, each its own Safe, in the order they are created. */
export const ROLES = [
	"arbiter",
	"guardian",
	"sealer",
	"treasury",
	"keeper",
] as const;
export type Role = (typeof ROLES)[number];

/** What a person writes for one network: what it reuses, who holds each role, and the parameters. */
export type Manifest = {
	deployer: Address;
	/** The test network's price publisher, which owns the test feed; never the deployer. */
	publisher?: Address;
	thirdParty: Record<string, Address[]>;
	roles: Record<
		Role,
		{ owners: Address[]; threshold: number; saltNonce: string }
	>;
	resolver: {
		bond: string;
		burn: string;
		liveness: number;
		expiry: number;
		arbiterTimeout: number;
	};
	creProposer: { workflowName: string; workflowOwner?: Address };
	logical: Record<string, string>;
	testnet?: { stocks: { symbol: string; name: string }[] };
};

/** One transaction of the deployment, and what it creates. */
export type Step = {
	key: string;
	address: Address;
	to: Address;
	data: Hex;
} & (
	| {
			kind: "safe";
			role: Role;
			singleton: Address;
			saltNonce: string;
			owners: Address[];
			threshold: number;
	  }
	| { kind: "create2"; contract: string; salt: Hex; constructorArgs: Hex }
);

/** The workflow name a receiver checks: the ASCII of the first ten hex characters of its hash. */
export function workflowNameOf(name: string): Hex {
	const digest = createHash("sha256").update(name).digest("hex");
	return stringToHex(digest.slice(0, 10), { size: 10 });
}

function one(manifest: Manifest, key: string): Address {
	const address = manifest.thirdParty[key]?.[0];
	if (address === undefined) throw new Error(`the manifest names no ${key}`);
	return address;
}

/**
 * The deployment list.
 * @param chainId The chain it is for.
 * @param manifest What a person wrote for that chain.
 * @param proxyCreationCode The Safe proxy factory's creation code, read from that chain.
 */
export function plan(
	chainId: number,
	manifest: Manifest,
	proxyCreationCode: Hex,
): Step[] {
	if (manifest.testnet && !TEST_CHAINS.includes(chainId)) {
		throw new Error(
			`refusing: test contracts are never deployed on chain ${chainId}`,
		);
	}
	// The publisher runs away from the server that holds the deployer's key, so the feed it writes
	// to is its own and the deployer's key never has to travel.
	if (manifest.testnet && !manifest.publisher) {
		throw new Error(
			"refusing: a test network manifest must name its price publisher",
		);
	}
	const steps: Step[] = [];
	const at = (key: string): Address => {
		const step = steps.find((s) => s.key === key);
		if (!step) throw new Error(`nothing planned under ${key}`);
		return step.address;
	};
	const logical = (name: string): Address => {
		const reference = manifest.logical[name];
		if (!reference) throw new Error(`the manifest names no logical ${name}`);
		const [kind, key] = reference.split(":");
		if (kind === "thirdParty" && key) return one(manifest, key);
		if (kind === "generated" && key) return at(key);
		throw new Error(`not a logical reference: ${reference}`);
	};
	const create2 = (
		key: string,
		contract: string,
		args: readonly unknown[] = [],
		salt?: Hex,
	) => {
		const { abi, bytecode } = artifact(contract);
		const initCode = encodeDeployData({ abi, bytecode, args });
		const constructorArgs = `0x${initCode.slice(bytecode.length)}` as Hex;
		const chosen = salt ?? saltOf(key);
		steps.push({
			key,
			kind: "create2",
			contract,
			salt: chosen,
			constructorArgs,
			address: predict(chosen, initCode),
			to: CREATE2_DEPLOYER,
			data: concat([chosen, initCode]),
		});
	};

	const singleton = one(manifest, "safeSingleton");
	const factory = one(manifest, "safeProxyFactory");
	const handler = one(manifest, "safeFallbackHandler");
	for (const role of ROLES) {
		const { owners, threshold, saltNonce } = manifest.roles[role];
		const initializer = setupData(owners, threshold, handler);
		steps.push({
			key: `roles.${role}`,
			kind: "safe",
			role,
			singleton,
			saltNonce,
			owners,
			threshold,
			address: predictSafe(
				factory,
				singleton,
				initializer,
				BigInt(saltNonce),
				proxyCreationCode,
			),
			to: factory,
			data: createProxyData(singleton, initializer, BigInt(saltNonce)),
		});
	}

	if (manifest.testnet) {
		create2("TestnetDollar", "src/testnet/TestnetDollar.sol:TestnetDollar", [
			manifest.deployer,
		]);
		for (const { symbol, name } of manifest.testnet.stocks) {
			create2(
				`TestnetStock.${symbol}`,
				"src/testnet/TestnetStock.sol:TestnetStock",
				[name, symbol, manifest.deployer],
			);
		}
		create2(
			"TestnetStockOracle",
			"src/testnet/TestnetStockOracle.sol:TestnetStockOracle",
			[manifest.publisher],
		);
	}

	create2("MarketFactory", "src/MarketFactory.sol:MarketFactory");
	create2("ThresholdRegistry", "src/ThresholdRegistry.sol:ThresholdRegistry");
	const r = manifest.resolver;
	create2(
		"OptimisticResolver",
		"src/OptimisticResolver.sol:OptimisticResolver",
		[
			at("MarketFactory"),
			at("ThresholdRegistry"),
			at("roles.sealer"),
			at("roles.arbiter"),
			logical("dollar"),
			BigInt(r.bond),
			BigInt(r.burn),
			BigInt(r.liveness),
			BigInt(r.expiry),
			BigInt(r.arbiterTimeout),
		],
	);
	const hook = artifact("src/FreezeHook.sol:FreezeHook");
	const hookArgs = [
		one(manifest, "poolManager"),
		at("OptimisticResolver"),
		at("roles.guardian"),
	] as const;
	const { salt } = mineHookSalt(encodeDeployData({ ...hook, args: hookArgs }));
	create2("FreezeHook", "src/FreezeHook.sol:FreezeHook", hookArgs, salt);
	create2("PositionRouter", "src/PositionRouter.sol:PositionRouter", [
		at("FreezeHook"),
	]);

	const { workflowOwner, workflowName } = manifest.creProposer;
	if (workflowOwner) {
		create2("CreProposer", "src/CreProposer.sol:CreProposer", [
			one(manifest, "creForwarder"),
			at("OptimisticResolver"),
			workflowOwner,
			workflowNameOf(workflowName),
			at("roles.treasury"),
		]);
	}
	return steps;
}
