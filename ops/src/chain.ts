/**
 * Sending and reading. Every transaction is sent by the toolchain's own client, on the rehearsal and on
 * the network alike, so the signing path the irreversible run uses is the one a rehearsal exercised.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
	type Address,
	createPublicClient,
	type Hex,
	http,
	type PublicClient,
} from "viem";

/** How long one request may take: a fork reads the forked network's state lazily. */
export const REQUEST_TIMEOUT_MS = 120_000;

export function reader(url: string): PublicClient {
	return createPublicClient({
		transport: http(url, { timeout: REQUEST_TIMEOUT_MS }),
	});
}

/** How a transaction is signed: by the local node for a sender it impersonates, or by a keystore. */
export type Signer =
	| { kind: "unlocked" }
	| { kind: "keystore"; keystore: string; passwordFile: string }
	| { kind: "key"; key: string };

/**
 * How the toolchain's client signs for a signer. A key travels in the client's environment, which
 * only that process reads, never in its arguments, which any process on the machine can list.
 */
export function castSigning(signer: Signer): {
	args: string[];
	env: Record<string, string>;
} {
	if (signer.kind === "unlocked") return { args: ["--unlocked"], env: {} };
	if (signer.kind === "keystore")
		return {
			args: [
				"--keystore",
				signer.keystore,
				"--password-file",
				signer.passwordFile,
			],
			env: {},
		};
	return { args: [], env: { ETH_PRIVATE_KEY: signer.key } };
}

/** The receipt fields the runbook keeps. */
export type Sent = {
	txHash: Hex;
	block: number;
	gasLimit: bigint;
	gasUsed: bigint;
	price: bigint;
};

function cast(args: string[], env: Record<string, string> = {}): string {
	return execFileSync("cast", args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, ...env },
	}).trim();
}

/**
 * Sends one transaction with a gas limit equal to its estimate, since the network charges the limit,
 * and refuses anything but a successful receipt.
 */
export function send(
	url: string,
	from: Address,
	signer: Signer,
	to: Address,
	data: Hex,
): Sent {
	const gasLimit = cast([
		"estimate",
		"--from",
		from,
		"--rpc-url",
		url,
		to,
		data,
	]);
	const signing = castSigning(signer);
	const receipt = JSON.parse(
		cast(
			[
				"send",
				"--json",
				"--gas-limit",
				gasLimit,
				"--from",
				from,
				...signing.args,
				"--rpc-url",
				url,
				to,
				data,
			],
			signing.env,
		),
	) as {
		status: string;
		transactionHash: Hex;
		blockNumber: string;
		gasUsed: string;
		effectiveGasPrice: string;
	};
	if (BigInt(receipt.status) !== 1n)
		throw new Error(`transaction ${receipt.transactionHash} reverted`);
	return {
		txHash: receipt.transactionHash,
		block: Number(BigInt(receipt.blockNumber)),
		gasLimit: BigInt(gasLimit),
		gasUsed: BigInt(receipt.gasUsed),
		price: BigInt(receipt.effectiveGasPrice),
	};
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

/**
 * A local node forking a network at its head, which lets anyone act as any address: the rehearsal's
 * chain. It reports the forked network's chain id, so it is told apart by asking it what it is.
 */
export async function startRehearsal(upstream: string, chainId: number) {
	const port = await freePort();
	// A few blocks behind the head: an endpoint can report a head whose state it does not serve yet,
	// and the node then fails to start at all.
	const head = await reader(upstream).getBlockNumber();
	const node = spawn(
		"anvil",
		[
			"--port",
			String(port),
			"--fork-url",
			upstream,
			"--fork-block-number",
			String(head - 32n),
			"--network",
			"monad",
			"--auto-impersonate",
			"--silent",
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let failure = "";
	node.stderr?.on("data", (chunk: Buffer) => {
		failure += chunk.toString();
	});
	let exited = false;
	node.on("exit", () => {
		exited = true;
	});
	const url = `http://127.0.0.1:${port}`;
	const client = reader(url);
	for (let attempt = 0; ; attempt++) {
		if (exited)
			throw new Error(`the rehearsal node did not start: ${failure.trim()}`);
		try {
			const info = (await client.request({
				method: "anvil_nodeInfo" as never,
			})) as {
				forkConfig?: { forkUrl?: string };
			};
			if (!info.forkConfig?.forkUrl) throw new Error("the node is not a fork");
			if ((await client.getChainId()) !== chainId)
				throw new Error(`the fork is not of chain ${chainId}`);
			break;
		} catch (error) {
			if (attempt > 240) {
				node.kill();
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	return { url, stop: () => node.kill() };
}
