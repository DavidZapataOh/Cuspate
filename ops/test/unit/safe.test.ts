import {
	concat,
	decodeFunctionData,
	encodeAbiParameters,
	encodePacked,
	getContractAddress,
	type Hex,
	keccak256,
	pad,
	parseAbi,
} from "viem";
import { describe, expect, test } from "vitest";
import {
	createProxyData,
	execData,
	predictSafe,
	prevalidated,
	setupData,
} from "../../src/safe.ts";

const OWNER = "0xD521E05AEbB8d39087bC7B9101CD590177468fca";
const HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE = parseAbi([
	"function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
	"function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
]);

describe("a role's Safe", () => {
	test("is set up with its owners, its threshold and the fallback handler, and nothing else", () => {
		const { args } = decodeFunctionData({
			abi: SAFE,
			data: setupData([OWNER], 1, HANDLER),
		});
		expect(args).toEqual([
			[OWNER],
			1n,
			"0x0000000000000000000000000000000000000000",
			"0x",
			HANDLER,
			"0x0000000000000000000000000000000000000000",
			0n,
			"0x0000000000000000000000000000000000000000",
		]);
	});

	test("is predicted as the proxy factory creates it", () => {
		const initializer = setupData([OWNER], 1, HANDLER);
		const creationCode: Hex = "0x608060405234801561001057600080fd5b50";
		const nonce = 7n;
		const salt = keccak256(
			encodePacked(["bytes32", "uint256"], [keccak256(initializer), nonce]),
		);
		const code = concat([
			creationCode,
			encodeAbiParameters([{ type: "uint256" }], [BigInt(SINGLETON)]),
		]);
		expect(
			predictSafe(FACTORY, SINGLETON, initializer, nonce, creationCode),
		).toBe(
			getContractAddress({
				opcode: "CREATE2",
				from: FACTORY,
				salt,
				bytecode: code,
			}),
		);
		expect(createProxyData(SINGLETON, initializer, nonce).slice(0, 10)).toBe(
			"0x1688f0b9",
		);
	});

	test("executes for its single owner with a pre-validated signature", () => {
		expect(prevalidated(OWNER).toLowerCase()).toBe(
			concat([
				pad(OWNER, { size: 32 }),
				pad("0x00", { size: 32 }),
				"0x01",
			]).toLowerCase(),
		);
		const { args } = decodeFunctionData({
			abi: SAFE,
			data: execData(FACTORY, "0x1234", OWNER),
		});
		expect(args?.[0]).toBe(FACTORY);
		expect(args?.[2]).toBe("0x1234");
		expect(args?.[3]).toBe(0);
		expect(String(args?.[9]).toLowerCase()).toBe(
			prevalidated(OWNER).toLowerCase(),
		);
	});
});
