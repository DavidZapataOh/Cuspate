import { keccak256, toBytes } from "viem";
import { describe, expect, test } from "vitest";
import { castSigning } from "../../src/chain.ts";
import { loadEvents } from "../../src/events.ts";
import {
	INTERVAL_SECONDS,
	postsFrom,
	publisherSigner,
	symbolsToPost,
} from "../../src/publisher.ts";

const round = (price: bigint, session: number) =>
	[
		price,
		price - 10n,
		price + 10n,
		1_790_000_000n,
		1_790_000_005n,
		7n,
		session,
	] as const;

describe("the test network's price publisher", () => {
	test("posts each symbol the production feed prices in its regular session, as that feed reads", () => {
		const posts = postsFrom({
			TSLA: round(412_50000000n, 2),
			MU: round(1017_74500000n, 2),
		});
		expect(posts).toEqual([
			{
				priceId: keccak256(toBytes("TSLA")),
				price: 412_50000000n,
				bestBid: 412_49999990n,
				bestAsk: 412_50000010n,
				feedUpdateTimestamp: 1_790_000_000n,
			},
			{
				priceId: keccak256(toBytes("MU")),
				price: 1017_74500000n,
				bestBid: 1017_74499990n,
				bestAsk: 1017_74500010n,
				feedUpdateTimestamp: 1_790_000_000n,
			},
		]);
	});

	test("leaves out a symbol outside its regular session, so the test network goes quiet as production does", () => {
		const posts = postsFrom({
			TSLA: round(412_50000000n, 5),
			AAPL: round(251_10000000n, 2),
			NVDA: null,
		});
		expect(posts.map((p) => p.priceId)).toEqual([keccak256(toBytes("AAPL"))]);
	});

	test("opening a window outside the session posts the symbols named, at production's latest round", () => {
		const posts = postsFrom(
			{
				TSLA: round(412_50000000n, 5),
				META: round(700_00000000n, 3),
				NVDA: null,
			},
			true,
		);
		expect(posts.map((p) => p.priceId)).toEqual([
			keccak256(toBytes("TSLA")),
			keccak256(toBytes("META")),
		]);
	});

	test("publishes well inside the keeper's staleness bound", () => {
		expect(INTERVAL_SECONDS).toBeLessThanOrEqual(20 * 60);
	});

	test("signs with its own key: from the environment on a host, or from its keystore on the server, never the deployer's", () => {
		expect(publisherSigner({ PUBLISHER_KEY: `0x${"11".repeat(32)}` })).toEqual({
			kind: "key",
			key: `0x${"11".repeat(32)}`,
		});
		expect(
			publisherSigner({
				PUBLISHER_KEYSTORE: "/k",
				PUBLISHER_PASSWORD_FILE: "/p",
			}),
		).toEqual({ kind: "keystore", keystore: "/k", passwordFile: "/p" });
		expect(() =>
			publisherSigner({ DEPLOY_KEYSTORE: "/k", DEPLOY_PASSWORD_FILE: "/p" }),
		).toThrow(/PUBLISHER_KEY/);
	});

	test("a key from the environment reaches the signer through its environment, never its arguments", () => {
		const key = `0x${"22".repeat(32)}`;
		const { args, env } = castSigning({ kind: "key", key });
		expect(args.join(" ")).not.toContain("22".repeat(32));
		expect(env.ETH_PRIVATE_KEY).toBe(key);
	});
});

describe("which symbols the publisher posts", () => {
	const manifest = loadEvents(10143);
	const opened = (keys: string[]) => ({
		markets: Object.fromEntries(
			keys.map((k) => [`${k}/above`, { eventKey: k }]),
		),
	});
	const seconds = (iso: string) => BigInt(Date.parse(iso) / 1000);

	test("only symbols with a market open and not yet frozen", () => {
		const book = opened(["tsla-q3-2026", "meta-q3-2026", "hood-q3-2026"]);
		expect(
			symbolsToPost(book, manifest, seconds("2026-10-20T00:00:00Z")),
		).toEqual(["HOOD", "META", "TSLA"]);
		expect(
			symbolsToPost(book, manifest, seconds("2026-10-21T20:00:00Z")),
		).toEqual(["HOOD"]);
	});

	test("nothing before the first market opens", () => {
		expect(
			symbolsToPost({}, manifest, seconds("2026-10-14T00:00:00Z")),
		).toEqual([]);
	});
});
