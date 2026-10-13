import { execFileSync } from "node:child_process";
import { getContractAddress, keccak256, toBytes } from "viem";
import { describe, expect, test } from "vitest";
import {
	CREATE2_DEPLOYER,
	FREEZE_HOOK_FLAGS,
	hasHookFlags,
	mineHookSalt,
	predict,
	saltOf,
} from "../../src/create2.ts";

describe("deterministic addresses", () => {
	test("a key's salt is the hash of its versioned name", () => {
		expect(saltOf("MarketFactory")).toBe(
			keccak256(toBytes("cuspate.MarketFactory.v1")),
		);
	});

	test("an address is predicted as the deterministic deployer creates it, and as the toolchain computes it", () => {
		const initCode = "0x6080604052348015600f57600080fd5b50";
		const salt = saltOf("anything");
		const predicted = predict(salt, initCode);
		expect(predicted).toBe(
			getContractAddress({
				opcode: "CREATE2",
				from: CREATE2_DEPLOYER,
				salt,
				bytecode: initCode,
			}),
		);
		const cast = execFileSync(
			"cast",
			["create2", "--salt", salt, "--init-code", initCode],
			{ encoding: "utf8" },
		);
		expect(cast.toLowerCase()).toContain(predicted.toLowerCase());
	});

	test("the freeze hook's flags are before-initialize and before-swap, and nothing else", () => {
		expect(FREEZE_HOOK_FLAGS).toBe((1n << 13n) | (1n << 7n));
		expect(hasHookFlags("0x0000000000000000000000000000000000002080")).toBe(
			true,
		);
		expect(hasHookFlags("0x0000000000000000000000000000000000002081")).toBe(
			false,
		);
		expect(hasHookFlags("0x0000000000000000000000000000000000002180")).toBe(
			false,
		);
	});

	test("a mined salt gives an address carrying exactly the hook's flags", () => {
		const initCode = "0x6080604052348015600f57600080fd5b50aa";
		const { salt, address } = mineHookSalt(initCode);
		expect(predict(salt, initCode)).toBe(address);
		expect(BigInt(address) & ((1n << 14n) - 1n)).toBe(0x2080n);
	});
});
