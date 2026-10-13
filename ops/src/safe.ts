/**
 * Each role is a Safe 1.4.1. These are the calls that create one and that make it act, encoded here
 * so the runbook and the role scripts send exactly what was rehearsed.
 */
import {
	type Address,
	concat,
	encodeAbiParameters,
	encodeFunctionData,
	encodePacked,
	getContractAddress,
	type Hex,
	keccak256,
	pad,
	parseAbi,
	zeroAddress,
} from "viem";

export const SAFE = parseAbi([
	"function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
	"function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
	"function getOwners() view returns (address[])",
	"function getThreshold() view returns (uint256)",
]);

export const PROXY_FACTORY = parseAbi([
	"function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)",
	"function proxyCreationCode() pure returns (bytes)",
]);

/** A Safe's set-up call: its owners, its threshold and the fallback handler, and no module. */
export function setupData(
	owners: Address[],
	threshold: number,
	fallbackHandler: Address,
): Hex {
	return encodeFunctionData({
		abi: SAFE,
		functionName: "setup",
		args: [
			owners,
			BigInt(threshold),
			zeroAddress,
			"0x",
			fallbackHandler,
			zeroAddress,
			0n,
			zeroAddress,
		],
	});
}

/** Where the proxy factory creates a Safe, from the same inputs it hashes. */
export function predictSafe(
	factory: Address,
	singleton: Address,
	initializer: Hex,
	saltNonce: bigint,
	proxyCreationCode: Hex,
): Address {
	const salt = keccak256(
		encodePacked(["bytes32", "uint256"], [keccak256(initializer), saltNonce]),
	);
	const bytecode = concat([
		proxyCreationCode,
		encodeAbiParameters([{ type: "uint256" }], [BigInt(singleton)]),
	]);
	return getContractAddress({
		opcode: "CREATE2",
		from: factory,
		salt,
		bytecode,
	});
}

/** The proxy factory call that creates a Safe. */
export function createProxyData(
	singleton: Address,
	initializer: Hex,
	saltNonce: bigint,
): Hex {
	return encodeFunctionData({
		abi: PROXY_FACTORY,
		functionName: "createProxyWithNonce",
		args: [singleton, initializer, saltNonce],
	});
}

/**
 * The signature a Safe accepts from an owner who is the transaction's own sender: the owner's address,
 * no s, and v of one. A one-of-one Safe then acts in a single transaction its owner sends.
 */
export function prevalidated(owner: Address): Hex {
	return concat([pad(owner, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]);
}

/** A call the Safe makes, sent by its owner with a pre-validated signature. */
export function execData(to: Address, data: Hex, owner: Address): Hex {
	return encodeFunctionData({
		abi: SAFE,
		functionName: "execTransaction",
		args: [
			to,
			0n,
			data,
			0,
			0n,
			0n,
			0n,
			zeroAddress,
			zeroAddress,
			prevalidated(owner),
		],
	});
}
