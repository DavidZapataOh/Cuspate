/**
 * The keeper's atomic account: a Safe owned by the keeper's key alone, executing a batch through the
 * deployed MultiSendCallOnly. Each execution is signed for the Safe's nonce at the time, so a signed
 * batch executes at most once, by whichever instance or retry lands first.
 */
import {
	type Address,
	concat,
	encodeFunctionData,
	encodePacked,
	type Hex,
	type PublicClient,
	size,
	zeroAddress,
} from "viem";
import type { LocalAccount } from "viem/accounts";
import { MULTI_SEND, SAFE } from "./abis.ts";
import type { Call } from "./correction.ts";

/** A Safe transaction, signed and ready to execute. */
export type SignedBatch = {
	safe: Address;
	safeNonce: bigint;
	to: Address;
	data: Hex;
	signature: Hex;
};

/** The packed transactions MultiSendCallOnly expects: each a call, no value. */
export function encodeMultiSend(calls: Call[]): Hex {
	return concat(
		calls.map((c) =>
			encodePacked(
				["uint8", "address", "uint256", "uint256", "bytes"],
				[0, c.to, 0n, BigInt(size(c.data)), c.data],
			),
		),
	);
}

/** Signs a batch for the Safe's current nonce: a delegate call into MultiSendCallOnly. */
export async function signBatch(
	client: PublicClient,
	owner: LocalAccount,
	safe: Address,
	multiSend: Address,
	calls: Call[],
): Promise<SignedBatch> {
	const data = encodeFunctionData({
		abi: MULTI_SEND,
		functionName: "multiSend",
		args: [encodeMultiSend(calls)],
	});
	const safeNonce = await client.readContract({
		address: safe,
		abi: SAFE,
		functionName: "nonce",
	});
	const hash = await client.readContract({
		address: safe,
		abi: SAFE,
		functionName: "getTransactionHash",
		args: [
			multiSend,
			0n,
			data,
			1,
			0n,
			0n,
			0n,
			zeroAddress,
			zeroAddress,
			safeNonce,
		],
	});
	if (owner.sign === undefined)
		throw new Error("the keeper's key cannot sign a raw hash");
	return {
		safe,
		safeNonce,
		to: multiSend,
		data,
		signature: await owner.sign({ hash }),
	};
}

/** The call that executes a signed batch. */
export function executionData(batch: SignedBatch): Hex {
	return encodeFunctionData({
		abi: SAFE,
		functionName: "execTransaction",
		args: [
			batch.to,
			0n,
			batch.data,
			1,
			0n,
			0n,
			0n,
			zeroAddress,
			zeroAddress,
			batch.signature,
		],
	});
}

/** Whether a signed batch can no longer execute: the Safe has moved past its nonce. */
export async function isSpent(
	client: PublicClient,
	batch: SignedBatch,
): Promise<boolean> {
	return (
		(await client.readContract({
			address: batch.safe,
			abi: SAFE,
			functionName: "nonce",
		})) > batch.safeNonce
	);
}
