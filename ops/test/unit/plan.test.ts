import { decodeAbiParameters, decodeFunctionData } from "viem";
import { describe, expect, test } from "vitest";
import { artifact } from "../../src/artifacts.ts";
import { type Manifest, plan, RECEIVER_BONDS } from "../../src/plan.ts";

const DEPLOYER = "0xD521E05AEbB8d39087bC7B9101CD590177468fca";
const PUBLISHER = "0xD605372d7b0C8412217c6f80D3E41712C82C7599";
const PM = "0x451D64ab3b650040d2aE1886602b97ed6eDc643d";

function manifest(overrides: Partial<Manifest> = {}): Manifest {
	return {
		deployer: DEPLOYER,
		publisher: PUBLISHER,
		thirdParty: {
			poolManager: [PM],
			safeSingleton: ["0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"],
			safeProxyFactory: ["0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"],
			safeFallbackHandler: ["0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"],
			creForwarder: ["0xF8344CFd5c43616a4366C34E3EEE75af79a74482"],
		},
		roles: Object.fromEntries(
			["arbiter", "guardian", "sealer", "treasury", "keeper"].map((role, i) => [
				role,
				{ owners: [DEPLOYER], threshold: 1, saltNonce: String(i + 1) },
			]),
		),
		resolver: {
			bond: "10000000",
			burn: "2000000",
			liveness: 600,
			expiry: 86400,
			arbiterTimeout: 7200,
		},
		creProposer: { workflowName: "cuspate-resolver-proposer" },
		logical: { dollar: "generated:TestnetDollar" },
		testnet: {
			stocks: [
				{ symbol: "TSLA", name: "Tesla test stock" },
				{ symbol: "MU", name: "Micron test stock" },
			],
		},
		...overrides,
	} as Manifest;
}

const CREATION = "0x608060405234801561001057600080fd5b50";

describe("the deployment list", () => {
	test("creates the role Safes, then the test contracts, then the protocol in dependency order", () => {
		const keys = plan(10143, manifest(), CREATION).map((step) => step.key);
		expect(keys).toEqual([
			"roles.arbiter",
			"roles.guardian",
			"roles.sealer",
			"roles.treasury",
			"roles.keeper",
			"TestnetDollar",
			"TestnetStock.TSLA",
			"TestnetStock.MU",
			"TestnetStockOracle",
			"MarketFactory",
			"ThresholdRegistry",
			"OptimisticResolver",
			"FreezeHook",
			"PositionRouter",
			"TestnetReportProbe",
		]);
	});

	test("leaves the receiver out until the workflow's owner is known, and adds it once it is", () => {
		const without = plan(10143, manifest(), CREATION).map((s) => s.key);
		expect(without).not.toContain("CreProposer");
		const withOwner = plan(
			10143,
			manifest({
				creProposer: {
					workflowName: "cuspate-resolver-proposer",
					workflowOwner: "0x00000000000000000000000000000000000c0de0",
				},
			}),
			CREATION,
		).map((s) => s.key);
		expect(withOwner.at(-1)).toBe("CreProposer.bonds");
		expect(withOwner.at(-2)).toBe("CreProposer");
	});

	test("on the test network the receiver is funded with test dollars for its bonds", () => {
		const steps = plan(
			10143,
			manifest({
				creProposer: {
					workflowName: "cuspate-resolver-proposer",
					workflowOwner: "0x00000000000000000000000000000000000c0de0",
				},
			}),
			CREATION,
		);
		const receiver = steps.find((s) => s.key === "CreProposer");
		const dollar = steps.find((s) => s.key === "TestnetDollar");
		const bonds = steps.at(-1);
		if (bonds?.kind !== "mint") throw new Error("no bond mint planned");
		expect(bonds.to).toBe(dollar?.address);
		expect(bonds.recipient).toBe(receiver?.address);
		expect(bonds.amount).toBe(
			BigInt(manifest().resolver.bond) * RECEIVER_BONDS,
		);
		const [recipient, amount] = decodeFunctionData({
			abi: artifact("src/testnet/TestnetToken.sol:TestnetToken").abi,
			data: bonds.data,
		}).args as [string, bigint];
		expect([recipient, amount]).toEqual([receiver?.address, bonds.amount]);
	});

	test("every address is predicted before anything is sent, and the hook's carries its flags", () => {
		const steps = plan(10143, manifest(), CREATION);
		const hook = steps.find((s) => s.key === "FreezeHook");
		expect(BigInt(hook?.address ?? "0x0") & 0x3fffn).toBe(0x2080n);
		const addresses = new Set(steps.map((s) => s.address.toLowerCase()));
		expect(addresses.size).toBe(steps.length);
	});

	test("refuses test contracts on the production chain", () => {
		expect(() => plan(143, manifest(), CREATION)).toThrow(/test contracts/);
	});

	test("on the production chain, deploys only the protocol over the logical dollar it names", () => {
		const production = manifest({
			testnet: undefined,
			thirdParty: {
				...manifest().thirdParty,
				dollar: ["0x754704Bc059F8C67012fEd69BC8A327a5aafb603"],
			},
			logical: { dollar: "thirdParty:dollar" },
		});
		const keys = plan(143, production, CREATION).map((s) => s.key);
		expect(keys.some((k) => k.startsWith("Testnet"))).toBe(false);
		expect(keys).toContain("OptimisticResolver");
	});

	test("the test feed belongs to the manifest's publisher, never to the deployer", () => {
		const oracle = plan(10143, manifest(), CREATION).find(
			(s) => s.key === "TestnetStockOracle",
		);
		expect(oracle?.kind).toBe("create2");
		const [owner] = decodeAbiParameters(
			[{ type: "address" }],
			(oracle as { constructorArgs: `0x${string}` }).constructorArgs,
		);
		expect(owner).toBe(PUBLISHER);
	});

	test("refuses a test network manifest that names no publisher", () => {
		expect(() =>
			plan(10143, manifest({ publisher: undefined }), CREATION),
		).toThrow(/publisher/);
	});
});
