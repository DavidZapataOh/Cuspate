/**
 * The resolution workflow, end to end: a local chain holding the resolver, its registry and the
 * receiver, an event sealed on it for a real earnings release, and the real workflow run by the CRE
 * simulator against it, delivering its report. Success is read from the chain, never from the
 * simulator's log, which reports success even when the receiver reverts.
 *
 * Usage: bun e2e/run.ts [TICKER ...]   (default: every pinned issuer)
 * Needs CRE_API_KEY, Foundry (anvil) and the contracts built. Without the key it skips locally and
 * fails as "not evaluated" in CI.
 */
import { issuer, renderTerms } from "cuspate-shared";
import {
	type Abi,
	type Address,
	createTestClient,
	defineChain,
	type Hex,
	http,
	publicActions,
	toHex,
	walletActions,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { scale } from "../resolver-proposer/source";
import { PINNED, type Pinned } from "./pinned";

// The SDK's types make Node's modules unusable here, so paths and files go through Bun.
const CRE_DIR = `${import.meta.dir}/..`;
const OUT = `${import.meta.dir}/../../contracts/out`;
// The simulator delivers through this chain's simulation forwarder; mainnet's is copied onto the local
// chain, whose id is the production chain's so the workflow resolves it by its production name.
const FORWARDER: Address = "0x9eF6468C5f37b976E57d52054c693269479A784d";
const PRODUCTION_RPC = "https://rpc-mainnet.monadinfra.com";
// What the simulator writes into a report's metadata: a fixed owner, and the workflow's name as the
// first ten hex characters of its SHA-256.
const SIMULATED_OWNER: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKFLOW_NAME = "cuspate-resolver-proposer";
const USER_AGENT = "Cuspate ops@cuspate.xyz";
// The resolver as the test network is deployed with: bond 10 test dollars, burn 2, liveness ten
// minutes, expiry a day, arbiter timeout two hours.
const BOND = 10_000_000n;
const RESOLVER_ARGS = [BOND, 2_000_000n, 600n, 86_400n, 7_200n] as const;

const local = (port: number) =>
	defineChain({
		id: 143,
		name: "local production fork",
		nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
		rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } },
	});

async function artefact(
	file: string,
	name: string,
): Promise<{ abi: Abi; bytecode: Hex }> {
	const json = await Bun.file(`${OUT}/${file}/${name}.json`).json();
	return { abi: json.abi, bytecode: json.bytecode.object };
}

function freePort(): number {
	const server = Bun.serve({ port: 0, fetch: () => new Response() });
	const { port } = server;
	server.stop(true);
	if (port === undefined) throw new Error("no free port");
	return port;
}

async function rpc(url: string, method: string, params: unknown[]) {
	const reply = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const body = (await reply.json()) as { result?: unknown; error?: unknown };
	if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
	return body.result;
}

/** The issuer's live feed still lists the pinned filing, or the pin is out of date. */
async function stillListed(pinned: Pinned) {
	const { cik } = issuer(pinned.ticker);
	const feed = await fetch(
		`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=8-K&dateb=&owner=include&count=10&output=atom`,
		{ headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" } },
	);
	const text = await feed.text();
	if (!text.includes(pinned.accession)) {
		throw new Error(
			`${pinned.ticker}: ${pinned.accession} is no longer in the issuer's feed; update the pinned release`,
		);
	}
}

/** One issuer's run. Throws on any failure. */
async function runOne(pinned: Pinned, wasm: string) {
	const step = (what: string) => console.error(`${pinned.ticker}: ${what}`);
	await stillListed(pinned);
	step("the pinned release is in the feed");
	const announcesAt = BigInt(Date.parse(pinned.announcesAt) / 1000);
	const port = freePort();
	const url = `http://127.0.0.1:${port}`;
	const anvil = Bun.spawn(
		[
			"anvil",
			"--chain-id",
			"143",
			"--port",
			String(port),
			"--timestamp",
			String(announcesAt - 86_400n),
			"--slots-in-an-epoch",
			"1",
			"--silent",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	const work = `${Bun.env.TMPDIR ?? "/tmp"}/cre-e2e-${crypto.randomUUID()}`;
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				if ((await rpc(url, "eth_chainId", [])) === "0x8f") break;
			} catch {}
			if (attempt > 100) throw new Error("the local chain did not start");
			await Bun.sleep(100);
		}
		const key = generatePrivateKey();
		const account = privateKeyToAccount(key);
		const client = createTestClient({
			mode: "anvil",
			chain: local(port),
			transport: http(url),
			account,
		})
			.extend(publicActions)
			.extend(walletActions);
		await client.setBalance({ address: account.address, value: 10n ** 22n });
		const code = (await rpc(PRODUCTION_RPC, "eth_getCode", [
			FORWARDER,
			"latest",
		])) as Hex;
		await client.setCode({ address: FORWARDER, bytecode: code });
		step("the local chain runs, with the simulation forwarder");

		const deploy = async (
			file: string,
			name: string,
			args: readonly unknown[] = [],
		) => {
			const { abi, bytecode } = await artefact(file, name);
			const hash = await client.deployContract({
				abi,
				bytecode,
				args,
				chain: null,
			});
			const receipt = await client.waitForTransactionReceipt({ hash });
			if (!receipt.contractAddress) throw new Error(`${name} was not deployed`);
			return { address: receipt.contractAddress, abi };
		};
		const send = async (
			to: { address: Address; abi: Abi },
			functionName: string,
			args: readonly unknown[],
		) => {
			const hash = await client.writeContract({
				...to,
				functionName,
				args,
				chain: null,
			});
			const receipt = await client.waitForTransactionReceipt({ hash });
			if (receipt.status !== "success")
				throw new Error(`${functionName} reverted`);
		};
		const read = (
			from: { address: Address; abi: Abi },
			functionName: string,
			args: readonly unknown[] = [],
		) => client.readContract({ ...from, functionName, args });

		const dollar = await deploy("PositionVault.t.sol", "TestCollateral");
		const factory = await deploy("MarketFactory.sol", "MarketFactory");
		const registry = await deploy("ThresholdRegistry.sol", "ThresholdRegistry");
		const resolver = await deploy(
			"OptimisticResolver.sol",
			"OptimisticResolver",
			[
				factory.address,
				registry.address,
				account.address,
				account.address,
				dollar.address,
				...RESOLVER_ARGS,
			],
		);
		const name = new Bun.CryptoHasher("sha256")
			.update(WORKFLOW_NAME)
			.digest("hex")
			.slice(0, 10);
		const receiver = await deploy("CreProposer.sol", "CreProposer", [
			FORWARDER,
			resolver.address,
			SIMULATED_OWNER,
			toHex(name),
			account.address,
		]);
		await send(dollar, "mint", [receiver.address, BOND * 10n]);
		step("deployed the registry, the resolver and the receiver");

		// Two thresholds on the release's figure, one below it and one above, both resolved by the same
		// read; and one event whose configured terms are not the sealed ones, which must abstain.
		const figure = scale(pinned.figure, 2).value;
		const profile = issuer(pinned.ticker);
		const terms = renderTerms(profile, {
			period: pinned.period,
			fallback: "the issuer's investor relations website",
			fallbackFrom: new Date(Number(announcesAt + 86_400n) * 1000)
				.toISOString()
				.replace(/\.\d{3}Z$/, "Z"),
		});
		const thresholds = [figure - 1n, figure + 1n, figure - 2n];
		const events: Hex[] = [];
		for (const value of thresholds) {
			const threshold = {
				value,
				decimals: 2,
				announcesAt,
				deadline: announcesAt + 8n * 86_400n,
				terms: toHex(terms),
			};
			await send(registry, "seal", [threshold]);
			events.push(
				(await read(registry, "eventIdOf", [
					account.address,
					threshold,
				])) as Hex,
			);
		}

		await client.setNextBlockTimestamp({ timestamp: announcesAt + 3600n });
		await client.mine({ blocks: 3 });
		step("sealed three events and moved past the announcement");

		const config = {
			schedule: "0 */10 * * * *",
			chainSelectorName: "monad-mainnet",
			isTestnet: false,
			resolver: resolver.address,
			receiver: receiver.address,
			userAgent: USER_AGENT,
			dueWindowSeconds: 10 * 365 * 24 * 3600 - 1,
			issuers: [
				{
					issuer: pinned.ticker,
					period: pinned.period,
					events: [
						{ eventId: events[0], terms, announcesAt: Number(announcesAt) },
						{ eventId: events[1], terms, announcesAt: Number(announcesAt) },
						{
							eventId: events[2],
							terms: `${terms} `,
							announcesAt: Number(announcesAt),
						},
					],
				},
			],
		};
		const configFile = `${work}/config.json`;
		await Bun.write(configFile, JSON.stringify(config));

		const before = (await read(dollar, "balanceOf", [
			receiver.address,
		])) as bigint;
		const simulate = Bun.spawnSync(
			[
				"cre",
				"workflow",
				"simulate",
				"resolver-proposer",
				"--target",
				"local-e2e",
				"--broadcast",
				"--non-interactive",
				"--trigger-index",
				"0",
				"--config",
				configFile,
				"--wasm",
				wasm,
			],
			{
				cwd: CRE_DIR,
				env: {
					...process.env,
					LOCAL_E2E_RPC_URL: url,
					CRE_ETH_PRIVATE_KEY: key.slice(2),
				},
			},
		);
		const log = simulate.stdout.toString() + simulate.stderr.toString();
		step(`the simulation exited ${simulate.exitCode}`);
		if (simulate.exitCode !== 0)
			throw new Error(`the simulation failed:\n${log}`);

		// The chain is the only witness.
		const round = async (id: Hex) => {
			const state = (await read(resolver, "eventOf", [id])) as {
				rounds: readonly {
					proposer: Address;
					figure: bigint;
					decimals: number;
				}[];
			};
			return state.rounds[0];
		};
		for (const id of events.slice(0, 2)) {
			const proposed = await round(id);
			if (proposed.proposer.toLowerCase() !== receiver.address.toLowerCase())
				throw new Error(
					`${pinned.ticker} ${id}: not proposed by the receiver\n${log}`,
				);
			if (proposed.figure !== figure || proposed.decimals !== 2)
				throw new Error(
					`${pinned.ticker} ${id}: proposed ${proposed.figure}/${proposed.decimals}, expected ${figure}/2`,
				);
		}
		const mismatched = await round(events[2]);
		if (mismatched.proposer !== "0x0000000000000000000000000000000000000000")
			throw new Error(
				`${pinned.ticker}: the event with other terms was proposed`,
			);
		const after = (await read(dollar, "balanceOf", [
			receiver.address,
		])) as bigint;
		if (before - after !== 2n * BOND)
			throw new Error(
				`${pinned.ticker}: the receiver posted ${before - after}, expected two bonds`,
			);
		console.log(
			`${pinned.ticker}: proposed ${pinned.figure} for two events through the forwarder; the third abstained`,
		);
	} finally {
		anvil.kill();
		Bun.spawnSync(["rm", "-rf", work]);
	}
}

async function main() {
	if (!process.env.CRE_API_KEY) {
		if (process.env.CI) {
			console.error("cre e2e: not evaluated: CRE_API_KEY is not set");
			process.exit(1);
		}
		console.log("cre e2e: skipped: CRE_API_KEY is not set");
		return;
	}
	const wanted = process.argv.slice(2);
	const runs = PINNED.filter(
		(pinned) => wanted.length === 0 || wanted.includes(pinned.ticker),
	);
	const wasm = `${CRE_DIR}/.build/resolver-proposer.wasm`;
	let failed = 0;
	for (const pinned of runs) {
		try {
			await runOne(pinned, wasm);
		} catch (error) {
			failed++;
			console.error(error instanceof Error ? error.message : error);
		}
	}
	if (failed > 0) process.exit(1);
}

await main();
