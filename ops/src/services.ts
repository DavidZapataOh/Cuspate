/**
 * The services' configuration for a network, generated from its record: the indexer's chain, the
 * keeper's markets and the resolution workflow's events. Nothing here is written by hand, and nothing
 * already written is replaced without being asked to.
 *
 *   DEPLOY_NETWORK=monad_testnet node ops/src/services.ts [--overwrite]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Address, type Hex, hexToString } from "viem";
import { artifact, contractsDir } from "./artifacts.ts";
import { type Book, committedPath, readBook } from "./book.ts";
import { reader } from "./chain.ts";
import { type EventManifest, loadEvents } from "./events.ts";
import { type Alias, NETWORKS } from "./runbook.ts";

const repo = path.resolve(contractsDir, "..");
/** Who the workflow says it is to the SEC: a name and a contact address. */
const USER_AGENT = "Cuspate ops@cuspate.xyz";
/** The protocol contracts the indexer follows by address, as the base configuration names them. */
const INDEXED = [
	"MarketFactory",
	"FreezeHook",
	"PositionRouter",
	"ThresholdRegistry",
	"OptimisticResolver",
];
/** The platform's name for each network the workflow runs on. */
const CHAIN_NAMES: Record<number, { name: string; isTestnet: boolean }> = {
	143: { name: "monad-mainnet", isTestnet: false },
	10143: { name: "monad-testnet", isTestnet: true },
};

type Recorded = {
	eventKey: string;
	issuer: string;
	eventId: Hex;
	marketId: Hex;
};

function addressOf(book: Book, key: string): Address {
	const entry = book[key] as { address?: Address } | undefined;
	if (!entry?.address) throw new Error(`the record has no ${key}`);
	return entry.address;
}

function marketsOf(book: Book): Recorded[] {
	return Object.values((book.markets ?? {}) as Record<string, Recorded>).sort(
		(a, b) =>
			a.issuer.localeCompare(b.issuer) || a.marketId.localeCompare(b.marketId),
	);
}

/**
 * The indexer's configuration for one network: the base configuration's contracts and events, and a
 * chain that follows this network's record from its first block. Through HyperSync, which reads the
 * Envio API token from the environment, unless a rehearsal fork's endpoint is given.
 */
export function indexerConfig(
	base: string,
	book: Book,
	chainId: number,
	fork?: { url: string; startBlock: number },
): string {
	// The base's opening comment describes the base; this file says where it came from instead.
	const body = base.slice(base.search(/^[^#\n]/m), base.indexOf("chains:"));
	const head = `# Generated from chain ${chainId}'s record by ops/src/services.ts: regenerate it, never edit it.\n${body}`;
	const first = Math.min(
		...INDEXED.map((key) => (book[key] as { block: number }).block),
	);
	const poolManager = book.thirdParty?.poolManager?.[0];
	if (!poolManager) throw new Error("the record names no pool manager");
	const lines = [
		"chains:",
		`  - id: ${chainId}`,
		`    start_block: ${fork ? fork.startBlock : first}`,
	];
	if (fork) lines.push("    rpc:", `      url: ${fork.url}`, "      for: sync");
	else
		lines.push(
			"    # HyperSync, authenticated by ENVIO_API_TOKEN; no endpoint is read for history.",
		);
	lines.push("    contracts:");
	for (const name of [
		"MarketFactory",
		"PositionVault",
		"PositionToken",
		"FreezeHook",
		"PositionRouter",
		"ThresholdRegistry",
		"OptimisticResolver",
	]) {
		lines.push(`      - name: ${name}`);
		if (INDEXED.includes(name))
			lines.push(`        address: "${addressOf(book, name)}"`);
	}
	lines.push("      - name: PoolManager", `        address: "${poolManager}"`);
	return `${head}${lines.join("\n")}\n`;
}

/** The markets the keeper keeps on a network, each with its event and the symbol it is priced by. */
export function keeperMarkets(book: Book, chainId: number) {
	return {
		chainId,
		markets: marketsOf(book).map((m) => ({
			marketId: m.marketId,
			eventId: m.eventId,
			symbol: m.issuer,
		})),
	};
}

/**
 * The workflow's configuration for a network: every recorded event, grouped by issuer, with the terms
 * and announcement read from the chain's seal, never from anywhere else. Reports go to the receiver
 * once it exists, and until then to the network's report probe.
 */
export function creConfig(
	book: Book,
	manifest: EventManifest,
	chainId: number,
	sealed: Record<string, { terms: Hex; announcesAt: bigint }>,
) {
	const chain = CHAIN_NAMES[chainId];
	if (!chain) throw new Error(`the workflow does not run on chain ${chainId}`);
	const receiver =
		(book.CreProposer as { address?: Address } | undefined)?.address ??
		(book.TestnetReportProbe as { address?: Address } | undefined)?.address;
	if (!receiver)
		throw new Error(
			"the record has no receiver for the workflow's reports, nor a probe",
		);
	const groups = new Map<
		string,
		{
			issuer: string;
			period: { quarter: number; fiscalYear: number };
			events: { eventId: Hex; terms: string; announcesAt: number }[];
		}
	>();
	const seen = new Set<string>();
	for (const market of marketsOf(book)) {
		if (seen.has(market.eventId)) continue;
		seen.add(market.eventId);
		const event = manifest.events.find((e) => e.eventKey === market.eventKey);
		if (!event)
			throw new Error(`${market.eventKey} is not in the event manifest`);
		const seal = sealed[market.eventId];
		if (!seal) throw new Error(`${market.eventId} was not read from the chain`);
		const key = `${event.issuer}/${event.period.quarter}/${event.period.fiscalYear}`;
		const group = groups.get(key) ?? {
			issuer: event.issuer,
			period: event.period,
			events: [],
		};
		group.events.push({
			eventId: market.eventId,
			terms: hexToString(seal.terms),
			announcesAt: Number(seal.announcesAt),
		});
		groups.set(key, group);
	}
	return {
		schedule: "0 */10 * * * *",
		chainSelectorName: chain.name,
		isTestnet: chain.isTestnet,
		resolver: addressOf(book, "OptimisticResolver"),
		receiver,
		userAgent: USER_AGENT,
		issuers: [...groups.values()],
	};
}

/** Writes a generated file, refusing to replace a different one unless told to. */
export function writeGenerated(
	file: string,
	content: string,
	overwrite: boolean,
): "written" | "unchanged" {
	if (existsSync(file)) {
		const current = readFileSync(file, "utf8");
		if (current === content) return "unchanged";
		if (!overwrite)
			throw new Error(
				`refusing: ${path.relative(repo, file)} differs from what the record generates; rerun with --overwrite to replace it`,
			);
	}
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
	return "written";
}

async function main(): Promise<void> {
	const alias = process.env.DEPLOY_NETWORK as Alias | undefined;
	if (!alias || !(alias in NETWORKS))
		throw new Error(
			`DEPLOY_NETWORK must be one of ${Object.keys(NETWORKS).join(", ")}`,
		);
	const network = NETWORKS[alias];
	const overwrite = process.argv.includes("--overwrite");
	const book = readBook(
		process.env.SERVICES_BOOK ?? committedPath(network.chainId),
	);
	const manifest = loadEvents(network.chainId);
	const out = (relative: string, content: string) =>
		console.error(
			`${relative}: ${writeGenerated(path.join(repo, relative), content, overwrite)}`,
		);

	out(
		`indexer/config.${network.chainId}.yaml`,
		indexerConfig(
			readFileSync(path.join(repo, "indexer/config.yaml"), "utf8"),
			book,
			network.chainId,
		),
	);
	if (marketsOf(book).length === 0) {
		console.error("keeper and workflow: skipped: the record has no market yet");
		return;
	}
	out(
		`keeper/markets/${network.chainId}.json`,
		`${JSON.stringify(keeperMarkets(book, network.chainId), null, "\t")}\n`,
	);

	const client = reader(network.url());
	const registry = {
		address: addressOf(book, "ThresholdRegistry"),
		abi: artifact("src/ThresholdRegistry.sol:ThresholdRegistry").abi,
	};
	const sealed: Record<string, { terms: Hex; announcesAt: bigint }> = {};
	for (const market of marketsOf(book)) {
		const [sealer, , threshold] = (await client.readContract({
			...registry,
			functionName: "sealOf",
			args: [market.eventId],
		})) as [Address, bigint, { terms: Hex; announcesAt: bigint }];
		if (BigInt(sealer) === 0n)
			throw new Error(
				`${market.eventKey}: ${market.eventId} is not sealed on chain ${network.chainId}`,
			);
		sealed[market.eventId] = threshold;
	}
	const name = CHAIN_NAMES[network.chainId]?.name;
	out(
		`cre/resolver-proposer/config.${name}.json`,
		`${JSON.stringify(creConfig(book, manifest, network.chainId, sealed), null, "\t")}\n`,
	);
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
