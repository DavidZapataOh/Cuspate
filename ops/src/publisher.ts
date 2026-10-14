/**
 * Mirrors the production feed's prices onto the test network's feed, so the test network's markets
 * trade around real prices: every symbol with a market still trading on the test network is read on
 * the production chain and posted on the test network in one transaction, at most every quarter of an
 * hour.
 *
 *   MONAD_RPC_URL=... MONAD_TESTNET_RPC_URL=... PUBLISHER_KEY=... node ops/src/publisher.ts [--once]
 *   ... node ops/src/publisher.ts --symbols TSLA,META   (once, to open a window outside the session)
 *   (or PUBLISHER_KEYSTORE and PUBLISHER_PASSWORD_FILE in place of PUBLISHER_KEY, on the server)
 */
import {
	type Address,
	encodeFunctionData,
	type Hex,
	keccak256,
	parseAbi,
	toBytes,
} from "viem";
import { artifact } from "./artifacts.ts";
import { committedPath, manifestOf, readBook } from "./book.ts";
import { reader, type Signer, send } from "./chain.ts";
import { type EventManifest, loadEvents } from "./events.ts";

/** How often prices are posted: inside the keeper's bound, which ignores a round older than 25 minutes. */
export const INTERVAL_SECONDS = 15 * 60;

/** The regular session, the only one the test network's feed reports. */
const REGULAR = 2;

const FEED = parseAbi([
	"function latestPrice(bytes32 priceId) view returns (int128 price, int128 bestBid, int128 bestAsk, uint64 feedUpdateTimestamp, uint64 publishedAt, uint80 roundId, uint8 session)",
]);

type Round = readonly [bigint, bigint, bigint, bigint, bigint, bigint, number];

/**
 * What to post, from what the production feed reads: only symbols it prices in their regular session,
 * unless a window is being opened outside it, when its symbols are posted at their latest round.
 */
export function postsFrom(
	rounds: Record<string, Round | null>,
	anySession = false,
) {
	return Object.entries(rounds)
		.filter(
			(entry): entry is [string, Round] =>
				entry[1] !== null && (anySession || entry[1][6] === REGULAR),
		)
		.map(([symbol, [price, bestBid, bestAsk, feedUpdateTimestamp]]) => ({
			priceId: keccak256(toBytes(symbol)),
			price,
			bestBid,
			bestAsk,
			feedUpdateTimestamp,
		}));
}

/**
 * The symbols worth posting: those of events with a market open whose announcement has not come, so
 * whose pools still trade. A frozen market needs no price, and every post costs gas.
 */
export function symbolsToPost(
	book: { [key: string]: unknown },
	manifest: EventManifest,
	now: bigint,
): string[] {
	const open = new Set(
		Object.values(
			(book.markets ?? {}) as Record<string, { eventKey: string }>,
		).map((m) => m.eventKey),
	);
	return [
		...new Set(
			manifest.events
				.filter(
					(e) =>
						open.has(e.eventKey) &&
						BigInt(Date.parse(e.announcesAt) / 1000) > now,
				)
				.map((e) => e.issuer),
		),
	].sort();
}

/**
 * The publisher's own signer: a key from the environment on a host that runs it, or its keystore on
 * the server. Never the deployer's.
 */
export function publisherSigner(
	env: Record<string, string | undefined>,
): Signer {
	if (env.PUBLISHER_KEY) return { kind: "key", key: env.PUBLISHER_KEY };
	if (env.PUBLISHER_KEYSTORE && env.PUBLISHER_PASSWORD_FILE)
		return {
			kind: "keystore",
			keystore: env.PUBLISHER_KEYSTORE,
			passwordFile: env.PUBLISHER_PASSWORD_FILE,
		};
	throw new Error(
		"the publisher signs with PUBLISHER_KEY, or with PUBLISHER_KEYSTORE and PUBLISHER_PASSWORD_FILE",
	);
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

async function once(named?: string[]): Promise<number> {
	const production = reader(required("MONAD_RPC_URL"));
	const feed = manifestOf(143).thirdParty.stockOracle?.[0] as Address;
	const testnet = manifestOf(10143);
	const symbols =
		named ??
		symbolsToPost(
			readBook(committedPath(10143)),
			loadEvents(10143),
			BigInt(Math.floor(Date.now() / 1000)),
		);
	const rounds: Record<string, Round | null> = {};
	for (const symbol of symbols) {
		try {
			rounds[symbol] = (await production.readContract({
				address: feed,
				abi: FEED,
				functionName: "latestPrice",
				args: [keccak256(toBytes(symbol))],
			})) as unknown as Round;
		} catch {
			rounds[symbol] = null;
		}
	}
	const posts = postsFrom(rounds, named !== undefined);
	if (posts.length === 0) return 0;
	const oracle = readBook(committedPath(10143)).TestnetStockOracle as
		| { address: Address }
		| undefined;
	if (!oracle) throw new Error("the test network's feed is not deployed yet");
	const data: Hex = encodeFunctionData({
		abi: artifact("src/testnet/TestnetStockOracle.sol:TestnetStockOracle").abi,
		functionName: "post",
		args: [posts],
	});
	if (!testnet.publisher)
		throw new Error("the test network's manifest names no publisher");
	send(
		required("MONAD_TESTNET_RPC_URL"),
		testnet.publisher,
		publisherSigner(process.env),
		oracle.address,
		data,
	);
	return posts.length;
}

if (process.argv[1]?.endsWith("publisher.ts")) {
	// Opening a window: `--symbols TSLA,META` posts those symbols once, at production's latest round.
	const at = process.argv.indexOf("--symbols");
	const named = at >= 0 ? process.argv[at + 1]?.split(",") : undefined;
	if (named) {
		once(named).then(
			(count) =>
				console.error(`${new Date().toISOString()} posted ${count} prices`),
			(error: Error) => {
				console.error(error.message);
				process.exit(1);
			},
		);
	}
	const loop = async () => {
		for (;;) {
			try {
				console.error(
					`${new Date().toISOString()} posted ${await once()} prices`,
				);
			} catch (error) {
				console.error(
					`${new Date().toISOString()} ${(error as Error).message}`,
				);
			}
			if (process.argv.includes("--once")) return;
			await new Promise((resolve) =>
				setTimeout(resolve, INTERVAL_SECONDS * 1000),
			);
		}
	};
	if (!named) void loop();
}
