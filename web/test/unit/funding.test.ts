import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isEvmAddress,
	isFinal,
	MONAD_USDC,
	quoteRequest,
	readQuote,
	readStatus,
	SOURCES,
	sourceById,
	toBaseUnits,
} from "../../src/funding/intents.ts";

const ADDRESS = "0xA473304874905844915b5f058C86Dda18244d1bF";

test("typed dollars become base units, and anything else is refused in words", () => {
	assert.deepEqual(toBaseUnits("25", 6), { units: 25_000_000n });
	assert.deepEqual(toBaseUnits("25.5", 6), { units: 25_500_000n });
	assert.deepEqual(toBaseUnits("1,000.25", 6), { units: 1_000_250_000n });
	assert.ok("error" in toBaseUnits("", 6));
	assert.ok("error" in toBaseUnits("abc", 6));
	assert.ok("error" in toBaseUnits("1.1234567", 6));
	assert.ok("error" in toBaseUnits("0.50", 6));
	assert.ok("error" in toBaseUnits("50001", 6));
});

test("every source is an EVM dollar token with a distinct id", () => {
	const ids = new Set(SOURCES.map((s) => s.id));
	assert.equal(ids.size, SOURCES.length);
	for (const s of SOURCES) {
		assert.ok(s.token === "USDC" || s.token === "USDT");
		assert.equal(s.decimals, 6);
	}
	assert.equal(sourceById("base-usdc")?.chain, "Base");
	assert.equal(sourceById("nowhere"), undefined);
});

test("a quote is asked for real, to Monad USDC, refunding to the same address", () => {
	const source = sourceById("base-usdc");
	assert.ok(source);
	const body = quoteRequest(source, 5_000_000n, ADDRESS, 0);
	assert.equal(body.dry, false);
	assert.equal(body.amount, "5000000");
	assert.equal(body.destinationAsset, MONAD_USDC.assetId);
	assert.equal(body.recipient, ADDRESS);
	assert.equal(body.refundTo, ADDRESS);
	assert.equal(body.deadline, "1970-01-01T01:00:00.000Z");
});

test("addresses are checked by shape", () => {
	assert.ok(isEvmAddress(ADDRESS));
	assert.ok(!isEvmAddress("0x123"));
	assert.ok(!isEvmAddress(undefined));
});

test("a quote answer reads only when it carries a deposit address", () => {
	const quote = {
		amountInFormatted: "5.0",
		amountOutFormatted: "4.988313",
		minAmountOut: "4938429",
		timeEstimate: 37,
		deadline: "2026-10-17T02:44:46.000Z",
		depositAddress: "0xb96aeD052eF654d826DdA9782653FEC40fEF094E",
	};
	assert.deepEqual(readQuote({ quote }), {
		depositAddress: quote.depositAddress,
		amountIn: "5.0",
		amountOut: "4.988313",
		minAmountOut: "4938429",
		seconds: 37,
		deadline: quote.deadline,
	});
	assert.equal(
		readQuote({ quote: { ...quote, depositAddress: undefined } }),
		undefined,
	);
	assert.equal(readQuote({ message: "Bad Request" }), undefined);
});

test("status answers map to the page's phases, and only the ends stop polling", () => {
	assert.deepEqual(readStatus({ status: "PENDING_DEPOSIT", swapDetails: {} }), {
		phase: "waiting",
		received: undefined,
		destinationTx: undefined,
	});
	const done = readStatus({
		status: "SUCCESS",
		swapDetails: {
			amountOutFormatted: "4.98",
			destinationChainTxHashes: [{ hash: "0xabc" }],
		},
	});
	assert.deepEqual(done, {
		phase: "arrived",
		received: "4.98",
		destinationTx: "0xabc",
	});
	assert.equal(readStatus({ status: "SOMETHING_NEW" }), undefined);
	assert.ok(isFinal("arrived"));
	assert.ok(isFinal("refunded"));
	assert.ok(!isFinal("moving"));
	assert.ok(!isFinal("short"));
});
