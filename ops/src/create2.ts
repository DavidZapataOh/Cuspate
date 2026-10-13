/**
 * Addresses through the deterministic deployer, which exists at the same address on both networks:
 * every contract's address is known before anything is sent.
 */
import {
	type Address,
	getContractAddress,
	type Hex,
	keccak256,
	numberToHex,
	pad,
	toBytes,
} from "viem";

/** The deterministic CREATE2 deployer. */
export const CREATE2_DEPLOYER: Address =
	"0x4e59b44847b379578588920cA78FbF26c0B4956C";

/** The low address bits a pool manager reads a hook's permissions from. */
export const HOOK_MASK = (1n << 14n) - 1n;

/** The freeze hook's permissions: before-initialize (bit 13) and before-swap (bit 7). */
export const FREEZE_HOOK_FLAGS = (1n << 13n) | (1n << 7n);

/** A deployment key's salt: the hash of its versioned name, the same on every network. */
export function saltOf(key: string): Hex {
	return keccak256(toBytes(`cuspate.${key}.v1`));
}

/** Where the deterministic deployer creates a contract from a salt and its creation code. */
export function predict(salt: Hex, initCode: Hex): Address {
	return getContractAddress({
		opcode: "CREATE2",
		from: CREATE2_DEPLOYER,
		salt,
		bytecode: initCode,
	});
}

/** Whether an address carries exactly the freeze hook's permissions. */
export function hasHookFlags(address: Address): boolean {
	return (BigInt(address) & HOOK_MASK) === FREEZE_HOOK_FLAGS;
}

/**
 * The first salt whose address carries exactly the hook's permissions. The creation code embeds the
 * pool manager, the resolver and the guardian, so the salt is mined again for every network and
 * whenever any of them changes.
 */
export function mineHookSalt(initCode: Hex): { salt: Hex; address: Address } {
	const hash = keccak256(initCode);
	for (let i = 0n; ; i++) {
		const salt = pad(numberToHex(i), { size: 32 });
		const address = getContractAddress({
			opcode: "CREATE2",
			from: CREATE2_DEPLOYER,
			salt,
			bytecodeHash: hash,
		});
		if (hasHookFlags(address)) return { salt, address };
	}
}
