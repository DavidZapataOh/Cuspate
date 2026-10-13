/**
 * The protocol's deployment, on either network, from one runbook.
 *
 *   DEPLOY_NETWORK=testnet_rehearsal tools/deploy.sh protocol   a fork of the test network: deploy,
 *                                                               measure, and run the end-to-end gate
 *   DEPLOY_NETWORK=mainnet_rehearsal tools/deploy.sh protocol   the same on a fork of the production
 *                                                               chain, with its manifest's placeholders
 *   DEPLOY_NETWORK=monad_testnet tools/deploy.sh protocol --broadcast
 *                                                               the test network itself, only after a
 *                                                               rehearsal passed on this exact commit
 *
 * The production chain is never broadcast to by this version.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Address, formatEther, type Hex } from "viem";
import { contractsDir } from "./artifacts.ts";
import {
	type Book,
	committedPath,
	type Generated,
	manifestOf,
	type RoleEntry,
	readBook,
	rehearsalPath,
	writeBook,
} from "./book.ts";
import {
	reader,
	type Sent,
	type Signer,
	send,
	startRehearsal,
} from "./chain.ts";
import { CREATE2_DEPLOYER } from "./create2.ts";
import { plan, type Step } from "./plan.ts";
import { PROXY_FACTORY } from "./safe.ts";

const repo = path.resolve(contractsDir, "..");

/** What each alias names: its chain, where it reads, and whether it is a rehearsal. */
export const NETWORKS = {
	testnet_rehearsal: {
		chainId: 10143,
		rehearsal: true,
		url: () =>
			process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz",
	},
	mainnet_rehearsal: {
		chainId: 143,
		rehearsal: true,
		url: () =>
			process.env.MONAD_ARCHIVE_RPC_URL ?? "https://rpc-mainnet.monadinfra.com",
	},
	monad_testnet: {
		chainId: 10143,
		rehearsal: false,
		url: () => required("MONAD_TESTNET_RPC_URL"),
	},
	monad: {
		chainId: 143,
		rehearsal: false,
		url: () => required("MONAD_RPC_URL"),
	},
} as const;
export type Alias = keyof typeof NETWORKS;

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** A rehearsal's verdict, which a broadcast requires for the commit it runs from. */
export function gatePath(chainId: number): string {
	return path.join(
		contractsDir,
		"deployments",
		".rehearsal",
		`${chainId}.gate.json`,
	);
}

/**
 * Refuses a broadcast the rules do not allow: never to the production chain in this version, never
 * from a manifest with placeholders, and never without a passed rehearsal of this exact, clean commit.
 */
export function refuseBroadcast(
	chainId: number,
	manifest: { placeholders?: boolean },
	commit: string,
	clean: boolean,
	gate: { commit?: string; passed?: boolean } | null,
): string | null {
	if (chainId === 143)
		return "refusing: the production chain waits for its owner's go and inputs";
	if (manifest.placeholders)
		return "refusing: the manifest still holds placeholders";
	if (!clean)
		return "refusing: the tree has uncommitted changes, so no rehearsal can vouch for it";
	if (!gate?.passed) return "refusing: no rehearsal of this network has passed";
	if (gate.commit !== commit)
		return `refusing: the rehearsal that passed ran on ${gate.commit}, not on ${commit}`;
	return null;
}

/** Sends every step not already on chain, recording each from its receipt the moment it lands. */
export async function deploy(options: {
	url: string;
	chainId: number;
	steps: Step[];
	bookFile: string;
	base: Book;
	deployer: Address;
	signer: Signer;
	commit: string;
}): Promise<{ sent: (Sent & { key: string })[]; skipped: string[] }> {
	const { url, steps, bookFile, deployer, signer, commit } = options;
	const client = reader(url);
	const book: Book = { ...options.base, ...readBook(bookFile) };
	const sent: (Sent & { key: string })[] = [];
	const skipped: string[] = [];
	for (const step of steps) {
		const recorded =
			step.kind === "safe"
				? book.roles?.[step.role]
				: (book[step.key] as Generated | undefined);
		const code = await client.getCode({ address: step.address });
		if (recorded && code && code !== "0x") {
			skipped.push(step.key);
			continue;
		}
		// The address commits to the creation code (and for a Safe to its whole set-up), so code
		// already there is this exact contract, whoever sent it: it is accepted, never re-sent.
		if (code && code !== "0x")
			throw new Error(
				`${step.key}: code exists at ${step.address} with no record; record it by hand after checking its creation transaction`,
			);
		const receipt = send(url, deployer, signer, step.to, step.data);
		const deployed = await client.getCode({ address: step.address });
		if (!deployed || deployed === "0x")
			throw new Error(
				`${step.key}: no code at the predicted ${step.address} after ${receipt.txHash}`,
			);
		if (step.kind === "safe") {
			const entry: RoleEntry = {
				address: step.address,
				factory: step.to,
				singleton: step.singleton,
				saltNonce: step.saltNonce,
				owners: step.owners,
				threshold: step.threshold,
				block: receipt.block,
				txHash: receipt.txHash,
			};
			book.roles = { ...book.roles, [step.role]: entry };
		} else {
			const entry: Generated = {
				address: step.address,
				factory: CREATE2_DEPLOYER,
				salt: step.salt,
				contract: step.contract,
				constructorArgs: step.constructorArgs,
				block: receipt.block,
				txHash: receipt.txHash,
				commit,
			};
			book[step.key] = entry;
		}
		writeBook(bookFile, book);
		sent.push({ ...receipt, key: step.key });
		console.error(
			`recorded ${step.key} at ${step.address} (${receipt.gasLimit} gas)`,
		);
	}
	return { sent, skipped };
}

/** The verification inputs, produced and scanned on every run; submitted only by a broadcast. */
function verify(url: string, steps: Step[], submit: boolean): void {
	const dir = path.join(contractsDir, "cache", "verification");
	mkdirSync(dir, { recursive: true });
	const inputs: string[] = [];
	for (const step of steps) {
		if (step.kind !== "create2") continue;
		const file = path.join(dir, `${step.key}.json`);
		const args =
			step.constructorArgs === "0x"
				? []
				: ["--constructor-args", step.constructorArgs];
		const input = execFileSync(
			"forge",
			[
				"verify-contract",
				"--show-standard-json-input",
				...args,
				step.address,
				step.contract,
			],
			{ cwd: contractsDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
		);
		writeFileSync(file, input);
		// What the scan reads is this repository's own sources in the input. The vendored libraries
		// travel with them, pinned by their submodules' commits: their own typography (a Greek letter
		// in a comment) is not this repository's text, and they cannot carry a term of ours.
		const { sources } = JSON.parse(input) as {
			sources: Record<string, unknown>;
		};
		const own = path.join(dir, `${step.key}.own.json`);
		writeFileSync(
			own,
			JSON.stringify({
				sources: Object.fromEntries(
					Object.entries(sources).filter(
						([source]) => !source.startsWith("lib/"),
					),
				),
			}),
		);
		inputs.push(own);
	}
	const scan = spawnSync(
		path.join(repo, "tools", "scan-forbidden.sh"),
		inputs,
		{ encoding: "utf8" },
	);
	process.stderr.write(`${scan.stdout}${scan.stderr}`);
	if (scan.status !== 0)
		throw new Error(
			"refusing: a verification input carries something that must not be published",
		);
	if (!submit) return;
	if (`${scan.stdout}${scan.stderr}`.includes("ran partially"))
		throw new Error(
			"refusing: the scanner skipped its hashed class, which is the one that matters before publishing",
		);
	for (const step of steps) {
		if (step.kind !== "create2") continue;
		const args =
			step.constructorArgs === "0x"
				? []
				: ["--constructor-args", step.constructorArgs];
		execFileSync(
			"forge",
			[
				"verify-contract",
				"--verifier",
				"sourcify",
				"--rpc-url",
				url,
				...args,
				step.address,
				step.contract,
			],
			{ cwd: contractsDir, stdio: "inherit" },
		);
	}
}

export async function main(argv: string[]): Promise<void> {
	const alias = process.env.DEPLOY_NETWORK as Alias | undefined;
	if (!alias || !(alias in NETWORKS))
		throw new Error(
			`DEPLOY_NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}`,
		);
	const network = NETWORKS[alias];
	const broadcast = argv.includes("--broadcast");
	const manifest = manifestOf(network.chainId);
	const commit = git(["rev-parse", "HEAD"]);
	execFileSync("forge", ["build"], { cwd: contractsDir, stdio: "ignore" });

	if (network.rehearsal) {
		const upstream = network.url();
		const node = await startRehearsal(upstream, network.chainId);
		try {
			const client = reader(node.url);
			if (manifest.placeholders)
				await client.request({
					method: "anvil_setBalance" as never,
					params: [manifest.deployer, "0x3635C9ADC5DEA00000"] as never,
				});
			const creation = (await client.readContract({
				address: manifest.thirdParty.safeProxyFactory?.[0] as Address,
				abi: PROXY_FACTORY,
				functionName: "proxyCreationCode",
			})) as Hex;
			const steps = plan(network.chainId, manifest, creation);
			const bookFile = rehearsalPath(network.chainId);
			writeBook(bookFile, { manifest, thirdParty: manifest.thirdParty });
			const { sent } = await deploy({
				url: node.url,
				chainId: network.chainId,
				steps,
				bookFile,
				base: {},
				deployer: manifest.deployer,
				signer: { kind: "unlocked" },
				commit,
			});
			verify(node.url, steps, false);
			const gas = sent.reduce((sum, s) => sum + s.gasLimit, 0n);
			// Priced at the network's own gas price, not the fork's: a local node lowers its base fee
			// over empty blocks, and the network charges what it charges.
			const live = reader(upstream);
			const price = await live.getGasPrice();
			const cost = gas * price;
			const balance = await live.getBalance({ address: manifest.deployer });
			console.error(
				`rehearsed ${sent.length} transactions: ${gas} gas charged, ${formatEther(cost)} MON at ${price} wei per gas; the deployer holds ${formatEther(balance)} MON`,
			);
			const gate = spawnSync(
				"pnpm",
				["--filter", "cuspate-ops", "run", "test:rehearsal"],
				{
					cwd: repo,
					stdio: "inherit",
					env: {
						...process.env,
						REHEARSAL_RPC_URL: node.url,
						REHEARSAL_CHAIN: String(network.chainId),
						REHEARSAL_BOOK: bookFile,
					},
				},
			);
			const affordable = manifest.placeholders || balance >= (cost * 12n) / 10n;
			const passed = gate.status === 0 && affordable;
			writeFileSync(
				gatePath(network.chainId),
				`${JSON.stringify({ commit, passed, transactions: sent.length, gas: String(gas), gasPriceWei: String(price), costWei: String(cost), deployerBalanceWei: String(balance) }, null, 2)}\n`,
			);
			if (!affordable)
				throw new Error(
					`refusing: the deployer holds ${formatEther(balance)} MON, below the measured ${formatEther(cost)} MON plus a fifth`,
				);
			if (gate.status !== 0)
				throw new Error("the end-to-end gate failed on the rehearsal");
			console.error(`the rehearsal passed on ${commit}`);
		} finally {
			node.stop();
		}
		return;
	}

	const url = network.url();
	const client = reader(url);
	if ((await client.getChainId()) !== network.chainId)
		throw new Error(`refusing: ${alias} reports another chain`);
	const creation = (await client.readContract({
		address: manifest.thirdParty.safeProxyFactory?.[0] as Address,
		abi: PROXY_FACTORY,
		functionName: "proxyCreationCode",
	})) as Hex;
	const steps = plan(network.chainId, manifest, creation);
	if (!broadcast) {
		for (const step of steps) console.error(`${step.key} ${step.address}`);
		console.error("predicted only; nothing was sent");
		return;
	}
	const gateFile = gatePath(network.chainId);
	const gate = existsSync(gateFile)
		? JSON.parse(readFileSync(gateFile, "utf8"))
		: null;
	const refusal = refuseBroadcast(
		network.chainId,
		manifest,
		commit,
		git(["status", "--porcelain"]) === "",
		gate,
	);
	if (refusal) throw new Error(refusal);
	const signer: Signer = {
		kind: "keystore",
		keystore: required("DEPLOY_KEYSTORE"),
		passwordFile: required("DEPLOY_PASSWORD_FILE"),
	};
	const bookFile = committedPath(network.chainId);
	await deploy({
		url,
		chainId: network.chainId,
		steps,
		bookFile,
		base: readBook(bookFile),
		deployer: manifest.deployer,
		signer,
		commit,
	});
	verify(url, steps, true);
}

if (
	process.argv[1] &&
	import.meta.url.endsWith(path.basename(process.argv[1]))
) {
	main(process.argv.slice(2)).catch((error: Error) => {
		console.error(error.message);
		process.exit(1);
	});
}
