/**
 * A local fork of the production chain at the pinned block, with the protocol deployed on it from
 * the repository's own build output, for tests that need the protocol on a real chain: the indexer's
 * reconciliation, and the services that act on a market.
 *
 * The third-party contracts a market needs (the pool manager, the collaterals) exist only on the
 * production chain, so a plain local chain cannot host one; a fork at the pinned block can, and
 * deploying from `contracts/out` adds no Solidity of its own.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Abi,
	type Address,
	concat,
	createPublicClient,
	createTestClient,
	createWalletClient,
	encodeAbiParameters,
	getContractAddress,
	type Hex,
	http,
	keccak256,
	numberToHex,
	pad,
	publicActions,
	walletActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const contracts = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../contracts",
);

/** The production chain's id. */
export const CHAIN_ID = 143;

/** The deterministic CREATE2 deployer, at the same address on every chain that has one. */
export const CREATE2_DEPLOYER: Address =
	"0x4e59b44847b379578588920cA78FbF26c0B4956C";

/** The low address bits a hook's permissions are read from, and the ones the freeze hook needs. */
const HOOK_FLAG_MASK = (1n << 14n) - 1n;
/** beforeInitialize (bit 13) and beforeSwap (bit 7). */
export const FREEZE_HOOK_FLAGS = (1n << 13n) | (1n << 7n);

/** The first key the local node funds, a well-known test key that holds nothing anywhere real. */
const DEPLOYER_KEY: Hex =
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const deployments = JSON.parse(
	readFileSync(path.join(contracts, "deployments", `${CHAIN_ID}.json`), "utf8"),
) as {
	pinnedBlock: number;
	thirdParty: Record<string, Address[]>;
};

/** The block every fork of the production chain is taken at. */
export const PINNED_BLOCK = BigInt(deployments.pinnedBlock);

/** A third-party contract on the production chain, by its key in the address book. */
export function thirdParty(key: string): Address {
	const address = deployments.thirdParty[key]?.[0];
	if (address === undefined)
		throw new Error(`no ${key} in contracts/deployments/${CHAIN_ID}.json`);
	return address;
}

/** A contract's ABI and creation code, from the build output. */
export function artifact(
	name: string,
	file = `${name}.sol`,
): { abi: Abi; bytecode: Hex } {
	const json = JSON.parse(
		readFileSync(path.join(contracts, "out", file, `${name}.json`), "utf8"),
	);
	return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
}

/** The archive endpoint the fork reads: the environment's, or the one the contracts' tests use. */
function archive(): string {
	const fromEnv = process.env.MONAD_ARCHIVE_RPC_URL;
	if (fromEnv) return fromEnv;
	const toml = readFileSync(path.join(contracts, "foundry.toml"), "utf8");
	const url = /^monad_archive\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
	if (url === undefined)
		throw new Error("no monad_archive endpoint in contracts/foundry.toml");
	return url;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address
					? resolve(address.port)
					: reject(new Error("no port")),
			);
		});
	});
}

/** A running fork and clients for it. */
export type Fork = Awaited<ReturnType<typeof startFork>>;

/** Starts a local node forking the production chain at the pinned block. */
export async function startFork() {
	const port = await freePort();
	const node: ChildProcess = spawn(
		"anvil",
		[
			"--port",
			String(port),
			"--fork-url",
			archive(),
			"--fork-block-number",
			String(PINNED_BLOCK),
			"--silent",
		],
		{ stdio: "ignore" },
	);
	const url = `http://127.0.0.1:${port}`;
	const account = privateKeyToAccount(DEPLOYER_KEY);
	const client = createTestClient({
		mode: "anvil",
		transport: http(url),
		account,
	})
		.extend(publicActions)
		.extend(walletActions);
	for (let attempt = 0; ; attempt++) {
		try {
			if ((await client.getChainId()) !== CHAIN_ID)
				throw new Error("the fork is not of the production chain");
			break;
		} catch (error) {
			if (attempt > 120) {
				node.kill();
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	return {
		url,
		client,
		account: account.address,
		stop: () => node.kill(),
		/** A wallet acting as `address`, which the node lets anyone impersonate. */
		async as(address: Address) {
			await client.impersonateAccount({ address });
			await client.setBalance({ address, value: 10n ** 22n });
			return createWalletClient({
				account: address,
				transport: http(url),
			}).extend(publicActions);
		},
		/** Gives `holder` `amount` of a real token. */
		async deal(token: Address, holder: Address, amount: bigint) {
			await client.request({
				method: "anvil_dealERC20" as never,
				params: [holder, token, numberToHex(amount)] as never,
			});
		},
		/** Moves the node's clock forward and mines a block at the new time. */
		async warp(seconds: bigint) {
			await client.increaseTime({ seconds: Number(seconds) });
			await client.mine({ blocks: 1 });
		},
	};
}

/** Deploys a contract from the build output and waits for it. */
export async function deploy(
	fork: Fork,
	name: string,
	args: readonly unknown[] = [],
) {
	const { abi, bytecode } = artifact(name);
	const hash = await fork.client.deployContract({
		abi,
		bytecode,
		args,
		chain: null,
	});
	const receipt = await fork.client.waitForTransactionReceipt({ hash });
	if (!receipt.contractAddress) throw new Error(`${name} was not deployed`);
	return { address: receipt.contractAddress, abi, block: receipt.blockNumber };
}

/**
 * Deploys the freeze hook through the deterministic deployer at a salt whose address carries exactly
 * the hook's permission bits, as the pool manager requires of a hook.
 */
export async function deployHook(
	fork: Fork,
	args: readonly [Address, Address, Address],
) {
	const { abi, bytecode } = artifact("FreezeHook");
	const constructorArgs = encodeAbiParameters(
		[{ type: "address" }, { type: "address" }, { type: "address" }],
		[...args],
	);
	const initCode = concat([bytecode, constructorArgs]);
	const initCodeHash = keccak256(initCode);
	for (let salt = 0n; ; salt++) {
		const saltHex = pad(numberToHex(salt), { size: 32 });
		const address = getContractAddress({
			opcode: "CREATE2",
			from: CREATE2_DEPLOYER,
			salt: saltHex,
			bytecodeHash: initCodeHash,
		});
		if ((BigInt(address) & HOOK_FLAG_MASK) !== FREEZE_HOOK_FLAGS) continue;
		const hash = await fork.client.sendTransaction({
			to: CREATE2_DEPLOYER,
			data: concat([saltHex, initCode]),
			chain: null,
		});
		await fork.client.waitForTransactionReceipt({ hash });
		return { address, abi };
	}
}

/** A read-only client for the fork, without the test actions. */
export function reader(fork: Fork) {
	return createPublicClient({ transport: http(fork.url) });
}
