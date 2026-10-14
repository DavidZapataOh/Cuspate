/**
 * Adding dollars from another chain: USDC or USDT on a major chain arrives as USDC on Monad at the
 * signed-in address, through the NEAR Intents 1Click service. This module is the pure part: which
 * deposits are offered, the request a quote is asked with, and how the service's answers read. The
 * network calls live only in the server routes, which hold the service's key.
 */

/** USDC on Monad mainnet, where every deposit arrives. */
export const MONAD_USDC = {
	assetId: "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx",
	contract: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
	decimals: 6,
} as const;

/** A dollar token on another chain that a deposit can start from. */
export type Source = {
	id: string;
	chain: string;
	token: "USDC" | "USDT";
	assetId: string;
	decimals: number;
};

/**
 * EVM chains only: the refund goes back to the same address on the chain the deposit came from, so
 * the signed-in address must be valid there.
 */
export const SOURCES: readonly Source[] = [
	{
		id: "base-usdc",
		chain: "Base",
		token: "USDC",
		assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
		decimals: 6,
	},
	{
		id: "arbitrum-usdc",
		chain: "Arbitrum",
		token: "USDC",
		assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
		decimals: 6,
	},
	{
		id: "ethereum-usdc",
		chain: "Ethereum",
		token: "USDC",
		assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
		decimals: 6,
	},
	{
		id: "ethereum-usdt",
		chain: "Ethereum",
		token: "USDT",
		assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
		decimals: 6,
	},
	{
		id: "optimism-usdc",
		chain: "Optimism",
		token: "USDC",
		assetId: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ",
		decimals: 6,
	},
	{
		id: "polygon-usdc",
		chain: "Polygon",
		token: "USDC",
		assetId: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
		decimals: 6,
	},
	{
		id: "avalanche-usdc",
		chain: "Avalanche",
		token: "USDC",
		assetId: "nep245:v2_1.omni.hot.tg:43114_3atVJH3r5c4GqiSYmg9fECvjc47o",
		decimals: 6,
	},
];

/** The source a deposit names by its id, or nothing for an id the page does not offer. */
export function sourceById(id: string): Source | undefined {
	return SOURCES.find((s) => s.id === id);
}

/** The smallest deposit offered, in whole dollars. */
export const MIN_DOLLARS = 1;
/** The largest deposit offered, in whole dollars. */
export const MAX_DOLLARS = 50_000;

/** How much slippage a quote tolerates, in basis points. */
export const SLIPPAGE_BPS = 100;

/** How long a quote's deposit address stays open. */
export const DEADLINE_MS = 60 * 60 * 1000;

/**
 * Dollars as typed, read into the token's base units. Returns a reason in words for anything that
 * is not a plain amount within the offered range.
 */
export function toBaseUnits(
	typed: string,
	decimals: number,
): { units: bigint } | { error: string } {
	const text = typed.trim().replace(/,/g, "");
	if (!/^\d+(\.\d*)?$|^\.\d+$/.test(text)) {
		return { error: "Enter an amount in dollars, like 25 or 25.50." };
	}
	const [whole = "0", fraction = ""] = text.split(".");
	if (fraction.length > decimals) {
		return { error: `Use at most ${decimals} decimal places.` };
	}
	const units =
		BigInt(whole || "0") * 10n ** BigInt(decimals) +
		BigInt((fraction || "").padEnd(decimals, "0") || "0");
	const unit = 10n ** BigInt(decimals);
	if (units < BigInt(MIN_DOLLARS) * unit) {
		return { error: `The smallest deposit is $${MIN_DOLLARS}.` };
	}
	if (units > BigInt(MAX_DOLLARS) * unit) {
		return {
			error: `The largest deposit is $${MAX_DOLLARS.toLocaleString("en-US")}.`,
		};
	}
	return { units };
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Whether a value is an EVM address: 0x and forty hex digits, in any case. */
export function isEvmAddress(value: unknown): value is string {
	return typeof value === "string" && EVM_ADDRESS.test(value);
}

/** The body 1Click is asked for a quote with: a real one, with a deposit address. */
export function quoteRequest(
	source: Source,
	units: bigint,
	address: string,
	now: number,
) {
	return {
		dry: false,
		swapType: "EXACT_INPUT",
		slippageTolerance: SLIPPAGE_BPS,
		originAsset: source.assetId,
		depositType: "ORIGIN_CHAIN",
		destinationAsset: MONAD_USDC.assetId,
		amount: units.toString(),
		refundTo: address,
		refundType: "ORIGIN_CHAIN",
		recipient: address,
		recipientType: "DESTINATION_CHAIN",
		deadline: new Date(now + DEADLINE_MS).toISOString(),
	};
}

/** A quote as the page shows it. */
export type Quote = {
	depositAddress: string;
	amountIn: string;
	amountOut: string;
	minAmountOut: string;
	seconds: number;
	deadline: string;
};

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads 1Click's quote answer; anything missing a deposit address is not a usable quote. */
export function readQuote(body: unknown): Quote | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const q = (body as { quote?: Record<string, unknown> }).quote;
	if (typeof q !== "object" || q === null) return undefined;
	const depositAddress = text(q.depositAddress);
	const amountIn = text(q.amountInFormatted);
	const amountOut = text(q.amountOutFormatted);
	const minAmountOut = text(q.minAmountOut);
	const deadline = text(q.deadline);
	const seconds = typeof q.timeEstimate === "number" ? q.timeEstimate : NaN;
	if (
		!depositAddress ||
		!amountIn ||
		!amountOut ||
		!minAmountOut ||
		!deadline ||
		!Number.isFinite(seconds)
	) {
		return undefined;
	}
	return {
		depositAddress,
		amountIn,
		amountOut,
		minAmountOut,
		seconds,
		deadline,
	};
}

/** Where a deposit is, in the words the page uses. */
export type Phase =
	| "waiting"
	| "seen"
	| "moving"
	| "arrived"
	| "short"
	| "refunded"
	| "failed";

const PHASES: Record<string, Phase> = {
	PENDING_DEPOSIT: "waiting",
	KNOWN_DEPOSIT_TX: "seen",
	PROCESSING: "moving",
	SUCCESS: "arrived",
	INCOMPLETE_DEPOSIT: "short",
	REFUNDED: "refunded",
	FAILED: "failed",
};

/** What the page says in each phase of a deposit. */
export const PHASE_TEXT: Record<Phase, string> = {
	waiting: "Waiting for your deposit.",
	seen: "Deposit seen. Waiting for it to confirm.",
	moving: "Moving your dollars to Monad.",
	arrived: "Arrived on Monad.",
	short:
		"Less than the quoted amount arrived. Send the rest, or wait for a refund.",
	refunded: "Refunded to the address you sent from.",
	failed: "This deposit did not go through. Anything sent is refunded.",
};

/** Whether polling can stop. */
export function isFinal(phase: Phase): boolean {
	return phase === "arrived" || phase === "refunded" || phase === "failed";
}

/** A deposit's progress as the page shows it. */
export type Progress = {
	phase: Phase;
	received?: string;
	destinationTx?: string;
};

/** Reads 1Click's status answer. */
export function readStatus(body: unknown): Progress | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const b = body as { status?: unknown; swapDetails?: Record<string, unknown> };
	const phase = typeof b.status === "string" ? PHASES[b.status] : undefined;
	if (!phase) return undefined;
	const details = b.swapDetails ?? {};
	const hashes = Array.isArray(details.destinationChainTxHashes)
		? details.destinationChainTxHashes
		: [];
	const first = hashes[0] as { hash?: unknown } | string | undefined;
	const destinationTx = typeof first === "string" ? first : text(first?.hash);
	return {
		phase,
		received: text(details.amountOutFormatted),
		destinationTx,
	};
}
