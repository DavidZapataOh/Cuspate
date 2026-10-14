/**
 * Opens the events due in a window, from the network's event manifest: each condition sealed from the
 * sealer's Safe, its market created, its collateral minted to the treasury, and its pools opened and
 * seeded in one batch from the treasury's Safe. Every market is recorded from its receipts the moment
 * it is open.
 *
 *   DEPLOY_NETWORK=testnet_rehearsal node ops/src/open-markets.ts --from <iso> --to <iso>
 *       a fork of the test network: prices mirrored, the batch opened, measured, and the gate run
 *   DEPLOY_NETWORK=monad_testnet node ops/src/open-markets.ts --from <iso> --to <iso> --broadcast
 *       the test network itself, only after a rehearsal of the same window passed on this commit
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	type Address,
	encodeFunctionData,
	formatEther,
	type Hex,
	keccak256,
	parseAbi,
	toBytes,
} from "viem";
import { artifact, contractsDir } from "./artifacts.ts";
import {
	type Book,
	committedPath,
	readBook,
	rehearsalPath,
	writeBook,
} from "./book.ts";
import { refuseBudget, tally } from "./budget.ts";
import {
	reader,
	type Sent,
	type Signer,
	send,
	startRehearsal,
} from "./chain.ts";
import {
	due,
	type EventEntry,
	type EventManifest,
	loadEvents,
	thresholdOf,
} from "./events.ts";
import { seedPlan } from "./markets.ts";
import { multiSendData } from "./pools.ts";
import { type Alias, NETWORKS } from "./runbook.ts";
import { batchExecData, execData } from "./safe.ts";
import { indexerConfig } from "./services.ts";

const repo = path.resolve(contractsDir, "..");
/** How old a published price may be when a market opens at it. */
export const MAX_PRICE_AGE_SECONDS = 4n * 86_400n;
/** The publisher posts every quarter hour of the regular session: 26 a day, five days a week. */
export const PUBLISHER_POSTS_PER_WEEK = 130n;
/** A keeper's correction through its Safe, with the margin it adds; budgeted once a week per market. */
export const KEEPER_CORRECTION_GAS = 1_500_000n;

const FEED = parseAbi([
	"function latestPrice(bytes32 priceId) view returns (int128 price, int128 bestBid, int128 bestAsk, uint64 feedUpdateTimestamp, uint64 publishedAt, uint80 roundId, uint8 session)",
]);
const ERC20 = parseAbi([
	"function balanceOf(address) view returns (uint256)",
	"function decimals() view returns (uint8)",
]);
const POSITIONS = parseAbi(["function nextTokenId() view returns (uint256)"]);
/** One opened market, as the record keeps it. */
export type MarketRecord = {
	eventKey: string;
	condition: string;
	issuer: string;
	threshold: string;
	eventId: Hex;
	marketId: Hex;
	stock: Address;
	underlyingVault: Address;
	dollarVault: Address;
	legs: {
		underlyingYes: Address;
		underlyingNo: Address;
		dollarYes: Address;
		dollarNo: Address;
	};
	shareCap: string;
	dollarCap: string;
	spot: string;
	chance: string;
	pools: {
		currency0: Address;
		currency1: Address;
		sqrtPriceX96: string;
		lower: number;
		upper: number;
	}[];
	tokenIds: string[];
	sealTx: Hex | null;
	createTx: Hex;
	seedTx: Hex;
	block: number;
};

/** A transaction the run sent, with the kind of step it was. */
export type Spent = Sent & { kind: string };

type Context = {
	url: string;
	book: Book;
	bookFile: string;
	manifest: EventManifest;
	signerFor: (owner: Address) => Signer;
};

function addressOf(book: Book, key: string): Address {
	const entry = book[key] as { address?: Address } | undefined;
	if (!entry?.address) throw new Error(`the record has no ${key}`);
	return entry.address;
}

function third(book: Book, key: string): Address {
	const address = book.thirdParty?.[key]?.[0];
	if (!address) throw new Error(`the record names no third-party ${key}`);
	return address;
}

function safeOf(book: Book, role: "sealer" | "treasury") {
	const safe = book.roles?.[role];
	if (!safe) throw new Error(`the record has no ${role} Safe`);
	return { address: safe.address, owner: safe.owners[0] as Address };
}

/** A whole number of `decimals` from a decimal text. */
function units(text: string, decimals: number): bigint {
	const [whole, fraction = ""] = text.split(".");
	return BigInt(`${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`);
}

/** Opens one condition of an event, skipping whatever is already on chain, and records it. */
async function openCondition(
	ctx: Context,
	event: EventEntry,
	conditionIndex: number,
	sent: Spent[],
): Promise<MarketRecord> {
	const { book, url } = ctx;
	const client = reader(url);
	const condition = event.conditions[conditionIndex];
	if (!condition)
		throw new Error(`${event.eventKey} has no condition ${conditionIndex}`);
	const registry = {
		address: addressOf(book, "ThresholdRegistry"),
		abi: artifact("src/ThresholdRegistry.sol:ThresholdRegistry").abi,
	};
	const factory = {
		address: addressOf(book, "MarketFactory"),
		abi: artifact("src/MarketFactory.sol:MarketFactory").abi,
	};
	const vaultAbi = artifact("src/PositionVault.sol:PositionVault").abi;
	const tokenAbi = artifact("src/testnet/TestnetToken.sol:TestnetToken").abi;
	const resolver = addressOf(book, "OptimisticResolver");
	const hook = addressOf(book, "FreezeHook");
	const oracle = addressOf(book, "TestnetStockOracle");
	const dollar = addressOf(book, "TestnetDollar");
	const stock = addressOf(book, event.stock);
	const deployer = book.manifest?.deployer as Address;
	const sealer = safeOf(book, "sealer");
	const treasury = safeOf(book, "treasury");
	const record = (kind: string, receipt: Sent) => {
		sent.push({ ...receipt, kind });
		return receipt;
	};

	// Sealed from the sealer's Safe, unless it already is.
	const threshold = thresholdOf(event, condition);
	const eventId = (await client.readContract({
		...registry,
		functionName: "eventIdOf",
		args: [sealer.address, threshold],
	})) as Hex;
	const [sealedBy] = (await client.readContract({
		...registry,
		functionName: "sealOf",
		args: [eventId],
	})) as [Address, bigint, { terms: Hex }];
	let sealTx: Hex | null = null;
	if (BigInt(sealedBy) === 0n) {
		const data = encodeFunctionData({
			abi: registry.abi,
			functionName: "seal",
			args: [threshold],
		});
		sealTx = record(
			"seal",
			send(
				url,
				sealer.owner,
				ctx.signerFor(sealer.owner),
				sealer.address,
				execData(registry.address, data, sealer.owner),
			),
		).txHash;
	}
	const [, , sealed] = (await client.readContract({
		...registry,
		functionName: "sealOf",
		args: [eventId],
	})) as [Address, bigint, { terms: Hex }];
	if (sealed.terms.toLowerCase() !== threshold.terms.toLowerCase())
		throw new Error(
			`${event.eventKey}: the sealed terms differ from the rendered ones`,
		);

	// The opening prices come from the feed, which must have published recently.
	const [price, , , , publishedAt] = (await client.readContract({
		address: oracle,
		abi: FEED,
		functionName: "latestPrice",
		args: [keccak256(toBytes(event.issuer))],
	})) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, number];
	const now = (await client.getBlock()).timestamp;
	if (price <= 0n || now - publishedAt > MAX_PRICE_AGE_SECONDS)
		throw new Error(
			`${event.issuer}: no recent price on the test feed; publish prices first`,
		);

	// The market and its caps: shares capped at the same dollar value as the dollars.
	const shareDecimals = Number(
		await client.readContract({
			address: stock,
			abi: ERC20,
			functionName: "decimals",
		}),
	);
	const dollarDecimals = Number(
		await client.readContract({
			address: dollar,
			abi: ERC20,
			functionName: "decimals",
		}),
	);
	const seeding = ctx.manifest.seeding;
	const dollarCap = units(seeding.dollarCap, dollarDecimals);
	const toShares = (dollarsText: string) =>
		(units(dollarsText, 8) * 10n ** BigInt(shareDecimals)) / price;
	const shareCap = toShares(seeding.shareCapValue) + 1n;
	const conditionId = (await client.readContract({
		...factory,
		functionName: "condition",
		args: [resolver, eventId],
	})) as Hex;
	const marketId = (await client.readContract({
		...factory,
		functionName: "marketId",
		args: [stock, dollar, conditionId, shareCap, dollarCap],
	})) as Hex;
	let [underlyingVault, dollarVault] = (await client.readContract({
		...factory,
		functionName: "markets",
		args: [marketId],
	})) as [Address, Address];
	let createTx: Hex = "0x";
	if (BigInt(underlyingVault) === 0n) {
		const data = encodeFunctionData({
			abi: factory.abi,
			functionName: "createMarket",
			args: [stock, dollar, eventId, resolver, shareCap, dollarCap],
		});
		createTx = record(
			"create",
			send(url, deployer, ctx.signerFor(deployer), factory.address, data),
		).txHash;
		[underlyingVault, dollarVault] = (await client.readContract({
			...factory,
			functionName: "markets",
			args: [marketId],
		})) as [Address, Address];
	}
	const legOf = async (vault: Address, side: "YES" | "NO") =>
		(await client.readContract({
			address: vault,
			abi: vaultAbi,
			functionName: side,
		})) as Address;
	const legs = {
		underlyingYes: await legOf(underlyingVault, "YES"),
		underlyingNo: await legOf(underlyingVault, "NO"),
		dollarYes: await legOf(dollarVault, "YES"),
		dollarNo: await legOf(dollarVault, "NO"),
	};

	// The treasury's collateral, minted by the test tokens' owner.
	const dollars = units(seeding.dollarsPerMarket, dollarDecimals);
	const shares = toShares(seeding.dollarsPerMarket);
	for (const [token, amount] of [
		[stock, shares],
		[dollar, dollars],
	] as const) {
		const held = (await client.readContract({
			address: token,
			abi: ERC20,
			functionName: "balanceOf",
			args: [treasury.address],
		})) as bigint;
		if (held < amount) {
			const data = encodeFunctionData({
				abi: tokenAbi,
				functionName: "mint",
				args: [treasury.address, amount - held],
			});
			record("mint", send(url, deployer, ctx.signerFor(deployer), token, data));
		}
	}

	// One batch from the treasury's Safe: register, open, split, approve, mint.
	const positionManager = third(book, "positionManager");
	const plan = seedPlan({
		marketId,
		eventId,
		hook,
		manager: third(book, "poolManager"),
		positionManager,
		permit2: third(book, "permit2"),
		stock,
		dollar,
		underlyingVault,
		dollarVault,
		legs,
		shareDecimals,
		dollarDecimals,
		spot: price,
		chance: Number(condition.openingChance),
		shares,
		dollars,
		halfWidthTicks: seeding.halfWidthTicks,
		nextTokenId: (await client.readContract({
			address: positionManager,
			abi: POSITIONS,
			functionName: "nextTokenId",
		})) as bigint,
		recipient: treasury.address,
		deadline: now + 3600n,
	});
	const multiSend = third(book, "safeMultiSendCallOnly");
	const seed = record(
		"seed",
		send(
			url,
			treasury.owner,
			ctx.signerFor(treasury.owner),
			treasury.address,
			batchExecData(multiSend, multiSendData(plan.calls), treasury.owner),
		),
	);

	return {
		eventKey: event.eventKey,
		condition: condition.key,
		issuer: event.issuer,
		threshold: condition.threshold,
		eventId,
		marketId,
		stock,
		underlyingVault,
		dollarVault,
		legs,
		shareCap: String(shareCap),
		dollarCap: String(dollarCap),
		spot: String(price),
		chance: condition.openingChance,
		pools: plan.pools.map((p) => ({
			currency0: p.key.currency0,
			currency1: p.key.currency1,
			sqrtPriceX96: String(p.sqrtPriceX96),
			lower: p.lower,
			upper: p.upper,
		})),
		tokenIds: plan.tokenIds.map(String),
		sealTx,
		createTx,
		seedTx: seed.txHash,
		block: seed.block,
	};
}

/**
 * Refuses to start a window any of whose stocks has no recent price on the test feed: every condition
 * is sealed before its market opens at the feed's price, so a missing price found midway would leave
 * sealed events with no market.
 */
async function requirePrices(
	ctx: Context,
	events: EventEntry[],
): Promise<void> {
	const client = reader(ctx.url);
	const now = (await client.getBlock()).timestamp;
	for (const symbol of new Set(events.map((e) => e.issuer))) {
		const [price, , , , publishedAt] = (await client
			.readContract({
				address: addressOf(ctx.book, "TestnetStockOracle"),
				abi: FEED,
				functionName: "latestPrice",
				args: [keccak256(toBytes(symbol))],
			})
			.catch(() => [0n, 0n, 0n, 0n, 0n, 0n, 0])) as readonly [
			bigint,
			bigint,
			bigint,
			bigint,
			bigint,
			bigint,
			number,
		];
		if (price <= 0n || now - publishedAt > MAX_PRICE_AGE_SECONDS)
			throw new Error(
				`refusing: ${symbol} has no recent price on the test feed; post it first with node ops/src/publisher.ts --symbols ${symbol}`,
			);
	}
}

/** Opens every condition of the events given, in order, recording each market as it opens. */
export async function openMarkets(
	ctx: Context,
	events: EventEntry[],
): Promise<Spent[]> {
	await requirePrices(ctx, events);
	const sent: Spent[] = [];
	for (const event of events) {
		for (let i = 0; i < event.conditions.length; i++) {
			const key = `${event.eventKey}/${event.conditions[i]?.key}`;
			const markets = (ctx.book.markets ?? {}) as Record<string, MarketRecord>;
			if (markets[key]?.seedTx) continue;
			const opened = await openCondition(ctx, event, i, sent);
			ctx.book.markets = { ...markets, [key]: opened };
			writeBook(ctx.bookFile, ctx.book);
			console.error(`opened ${key}: market ${opened.marketId}`);
		}
	}
	return sent;
}

function arg(name: string): string {
	const at = process.argv.indexOf(name);
	const value = at >= 0 ? process.argv[at + 1] : undefined;
	if (!value)
		throw new Error(
			`usage: open-markets.ts --from <iso> --to <iso> [--broadcast]`,
		);
	return value;
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** The verdict of a markets rehearsal, which a broadcast of the same window requires. */
export function marketsGatePath(chainId: number): string {
	return path.join(
		contractsDir,
		"deployments",
		".rehearsal",
		`${chainId}.markets.gate.json`,
	);
}

/** Mirrors production prices for the symbols due onto the fork, as the publisher would. */
async function mirrorPrices(
	url: string,
	book: Book,
	symbols: string[],
): Promise<Sent> {
	const production = reader(
		process.env.MONAD_ARCHIVE_RPC_URL ?? "https://rpc-mainnet.monadinfra.com",
	);
	const feed = readBook(committedPath(143)).thirdParty
		?.stockOracle?.[0] as Address;
	const posts = [];
	for (const symbol of symbols) {
		const [price, bestBid, bestAsk, feedUpdateTimestamp] =
			(await production.readContract({
				address: feed,
				abi: FEED,
				functionName: "latestPrice",
				args: [keccak256(toBytes(symbol))],
			})) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, number];
		posts.push({
			priceId: keccak256(toBytes(symbol)),
			price,
			bestBid,
			bestAsk,
			feedUpdateTimestamp,
		});
	}
	const data = encodeFunctionData({
		abi: artifact("src/testnet/TestnetStockOracle.sol:TestnetStockOracle").abi,
		functionName: "post",
		args: [posts],
	});
	const publisher = book.manifest?.publisher as Address;
	return send(
		url,
		publisher,
		{ kind: "unlocked" },
		addressOf(book, "TestnetStockOracle"),
		data,
	);
}

/**
 * Indexes the blocks the rehearsal wrote with the network's generated indexer configuration, read
 * through the fork's endpoint, and compares every market, leg and pool with the chain.
 */
async function reconcileIndexer(
	url: string,
	chainId: number,
	book: Book,
	bookFile: string,
	sent: Spent[],
): Promise<boolean> {
	const indexer = path.join(repo, "indexer");
	const config = "config.rehearsal.yaml";
	const startBlock = Math.min(...sent.map((s) => s.block));
	const endBlock = Number(await reader(url).getBlockNumber());
	writeFileSync(
		path.join(indexer, config),
		indexerConfig(
			readFileSync(path.join(indexer, "config.yaml"), "utf8"),
			book,
			chainId,
			{ url, startBlock },
		),
	);
	const env = { ...process.env, ENVIO_CONFIG: config };
	try {
		const codegen = spawnSync("pnpm", ["exec", "envio", "codegen"], {
			cwd: indexer,
			stdio: "inherit",
			env,
		});
		if (codegen.status !== 0) return false;
		const run = spawnSync(
			"pnpm",
			["exec", "vitest", "run", "--config", "vitest.rehearsal.config.ts"],
			{
				cwd: indexer,
				stdio: "inherit",
				env: {
					...env,
					REHEARSAL_RPC_URL: url,
					REHEARSAL_BOOK: bookFile,
					REHEARSAL_CHAIN: String(chainId),
					REHEARSAL_START_BLOCK: String(startBlock),
					REHEARSAL_END_BLOCK: String(endBlock),
				},
			},
		);
		return run.status === 0;
	} finally {
		// The indexer's own generated code is put back as its configuration has it.
		spawnSync("pnpm", ["exec", "envio", "codegen"], {
			cwd: indexer,
			stdio: "ignore",
			env: { ...process.env, ENVIO_CONFIG: undefined },
		});
	}
}

export async function main(): Promise<void> {
	const alias = process.env.DEPLOY_NETWORK as Alias | undefined;
	if (!alias || !(alias in NETWORKS))
		throw new Error(
			`DEPLOY_NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}`,
		);
	const network = NETWORKS[alias];
	if (network.chainId === 143)
		throw new Error("refusing: the production chain waits for its owner's go");
	const from = arg("--from");
	const to = arg("--to");
	const manifest = loadEvents(network.chainId);
	const events = due(manifest, from, to);
	if (events.length === 0)
		throw new Error(`no confirmed event is announced in [${from}, ${to})`);
	const commit = git(["rev-parse", "HEAD"]);
	execFileSync("forge", ["build"], { cwd: contractsDir, stdio: "ignore" });
	const window = { from, to, events: events.map((e) => e.eventKey) };

	if (network.rehearsal) {
		const upstream = network.url();
		const node = await startRehearsal(upstream, network.chainId);
		try {
			const book = readBook(committedPath(network.chainId));
			const bookFile = rehearsalPath(network.chainId);
			writeBook(bookFile, book);
			const post = await mirrorPrices(node.url, book, [
				...new Set(events.map((e) => e.issuer)),
			]);
			const sent = await openMarkets(
				{
					url: node.url,
					book,
					bookFile,
					manifest,
					signerFor: () => ({ kind: "unlocked" }),
				},
				events,
			);
			const live = reader(upstream);
			const price = await live.getGasPrice();
			const gas = sent.reduce((sum, s) => sum + s.gasLimit, 0n);
			// The keeper corrects only markets still trading: those whose announcement has not come.
			const now = Date.now();
			const opened = Object.values(
				(book.markets ?? {}) as Record<string, MarketRecord>,
			).filter(
				(m) =>
					Date.parse(
						manifest.events.find((e) => e.eventKey === m.eventKey)
							?.announcesAt ?? "",
					) > now,
			).length;
			const needs = {
				batch: gas * price,
				publisherWeek: post.gasLimit * PUBLISHER_POSTS_PER_WEEK * price,
				keeperWeek: KEEPER_CORRECTION_GAS * BigInt(opened) * price,
			};
			const held = {
				deployer: await live.getBalance({
					address: book.manifest?.deployer as Address,
				}),
				publisher: await live.getBalance({
					address: book.manifest?.publisher as Address,
				}),
				keeper: await live.getBalance({
					address: book.roles?.keeper?.owners[0] as Address,
				}),
			};
			const byKind = Object.fromEntries(
				Object.entries(tally(sent)).map(([kind, g]) => [kind, String(g)]),
			);
			const wei = (o: Record<string, bigint>) =>
				Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
			console.error(
				`rehearsed ${sent.length} transactions for ${events.length} events at ${price} wei per gas: ${gas} gas, ${formatEther(needs.batch)} MON (${JSON.stringify(byKind)}); a week of posting ${formatEther(needs.publisherWeek)} MON (${post.gasLimit} gas a post), of keeping ${opened} markets ${formatEther(needs.keeperWeek)} MON`,
			);
			const gate = spawnSync(
				"pnpm",
				["--filter", "cuspate-ops", "run", "test:markets"],
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
			const reconciled =
				gate.status === 0 &&
				(await reconcileIndexer(
					node.url,
					network.chainId,
					book,
					bookFile,
					sent,
				));
			const refusal = refuseBudget(held, needs);
			const passed = gate.status === 0 && reconciled && refusal === null;
			writeFileSync(
				marketsGatePath(network.chainId),
				`${JSON.stringify({ commit, passed, window, transactions: sent.length, gasPriceWei: String(price), gas: String(gas), gasByKind: byKind, needsWei: wei(needs), heldWei: wei(held) }, null, 2)}\n`,
			);
			if (refusal) throw new Error(refusal);
			if (gate.status !== 0)
				throw new Error("the markets gate failed on the rehearsal");
			if (!reconciled)
				throw new Error("the indexer did not reconcile with the rehearsal");
			console.error(`the markets rehearsal passed on ${commit}`);
		} finally {
			node.stop();
		}
		return;
	}

	if (!process.argv.includes("--broadcast"))
		throw new Error("refusing: a network run needs --broadcast");
	const gateFile = marketsGatePath(network.chainId);
	const gate = existsSync(gateFile)
		? JSON.parse(readFileSync(gateFile, "utf8"))
		: null;
	const refusal = refuseMarkets(
		commit,
		git(["status", "--porcelain"]) === "",
		gate,
		window,
	);
	if (refusal) throw new Error(refusal);
	const url = network.url();
	const bookFile = committedPath(network.chainId);
	const book = readBook(bookFile);
	const keystores: Record<string, Signer> = {
		[String(book.manifest?.deployer).toLowerCase()]: {
			kind: "keystore",
			keystore: required("DEPLOY_KEYSTORE"),
			passwordFile: required("DEPLOY_PASSWORD_FILE"),
		},
	};
	await openMarkets(
		{
			url,
			book,
			bookFile,
			manifest,
			signerFor: (owner) => {
				const signer = keystores[owner.toLowerCase()];
				if (!signer) throw new Error(`no key for ${owner}`);
				return signer;
			},
		},
		events,
	);
}

/** Refuses a broadcast no rehearsal vouches for: same commit, clean tree, same window, passed. */
export function refuseMarkets(
	commit: string,
	clean: boolean,
	gate: {
		commit?: string;
		passed?: boolean;
		window?: { from: string; to: string; events: string[] };
	} | null,
	window: { from: string; to: string; events: string[] },
): string | null {
	if (!clean)
		return "refusing: the tree has uncommitted changes, so no rehearsal can vouch for it";
	if (!gate?.passed) return "refusing: no markets rehearsal has passed";
	if (gate.commit !== commit)
		return `refusing: the rehearsal that passed ran on ${gate.commit}, not on ${commit}`;
	if (JSON.stringify(gate.window?.events) !== JSON.stringify(window.events))
		return "refusing: the rehearsal that passed opened other events";
	return null;
}

if (
	process.argv[1] &&
	import.meta.url.endsWith(path.basename(process.argv[1]))
) {
	main().catch((error: Error) => {
		console.error(error.message);
		process.exit(1);
	});
}
