import assert from "node:assert/strict";
import { test } from "node:test";
import { BANNED } from "../../src/lib/banned.ts";
import { type TicketInput, ticketView } from "../../src/ticket/view.ts";

const ANNOUNCES = "2026-10-21T20:00:00Z";
const before = Date.parse("2026-10-14T12:00:00Z");
const base: TicketInput = {
	live: true,
	amountCents: 50_000n,
	yes: true,
	condition: { issuer: "META", threshold: 639n, decimals: 2, primary: true },
	quote: { shares: 648_100_000_000_000_000n },
	account: "0x00000000000000000000000000000000000000aa",
	balanceCents: 100_000n,
	roomCents: 1_000_000n,
	nowMs: before,
	announcesAt: ANNOUNCES,
	phase: { kind: "idle" },
};

test("ready: both outcomes in the condition's own words with the quoted shares, and the buy button on", () => {
	const view = ticketView(base);
	assert.equal(view.state, "ready");
	assert.equal(view.buy.label, "Buy if above $6.39");
	assert.equal(view.buy.disabled, false);
	assert.equal(
		view.status,
		"If it's above $6.39: 0.6481 META shares. If not: $500.00 back.",
	);
	assert.equal(view.other, "or if not");
});

test("buying the other world says so on the button, and swaps what each world holds", () => {
	const view = ticketView({ ...base, yes: false });
	assert.equal(view.buy.label, "Buy if not");
	assert.equal(view.other, "or if above $6.39");
	assert.equal(
		view.status,
		"If not: 0.6481 META shares. If it's above $6.39: $500.00 back.",
	);
});

test("a market not yet open previews only, and says when buying opens", () => {
	const view = ticketView({ ...base, live: false });
	assert.equal(view.state, "preview");
	assert.equal(view.buy.disabled, true);
	assert.equal(view.status, "Buying opens once this market is live.");
});

test("after the announcement nothing can be bought, and the ticket says since when", () => {
	const view = ticketView({ ...base, nowMs: Date.parse(ANNOUNCES) });
	assert.equal(view.state, "closed");
	assert.equal(view.buy.disabled, true);
	assert.equal(view.status, "Trading closed at Oct 21, 4:00 pm ET.");
});

test("without a wallet the button signs in first", () => {
	const view = ticketView({ ...base, account: undefined });
	assert.equal(view.state, "connect");
	assert.equal(view.buy.label, "Sign in to buy");
	assert.equal(view.buy.disabled, false);
	assert.equal(view.buy.signsIn, true);
});

test("too few test dollars: how many more, nothing charged, and a way to get some", () => {
	const view = ticketView({ ...base, balanceCents: 20_000n });
	assert.equal(view.state, "short");
	assert.equal(view.buy.disabled, true);
	assert.equal(view.status, "You need $300.00 more. Nothing was charged.");
	assert.equal(view.offerTestDollars, true);
});

test("a full market says how much it still takes", () => {
	const view = ticketView({ ...base, roomCents: 12_000n });
	assert.equal(view.state, "full");
	assert.equal(view.buy.disabled, true);
	assert.equal(view.status, "This market is full. You can buy up to $120.00.");
});

test("while quoting, checking, signing and sending, the button is busy and says what is happening", () => {
	assert.equal(ticketView({ ...base, quote: undefined }).state, "quoting");
	assert.equal(ticketView({ ...base, quote: undefined }).buy.busy, true);
	const signing = ticketView({ ...base, phase: { kind: "signing" } });
	assert.equal(signing.buy.label, "Confirm in your wallet");
	assert.equal(signing.buy.busy, true);
	const pending = ticketView({ ...base, phase: { kind: "pending" } });
	assert.equal(pending.buy.label, "Buying...");
	assert.equal(
		ticketView({ ...base, phase: { kind: "checking" } }).buy.busy,
		true,
	);
});

test("done states what was bought; a failure says nothing moved", () => {
	const done = ticketView({
		...base,
		phase: { kind: "done", shares: 650_000_000_000_000_000n },
	});
	assert.equal(done.state, "done");
	assert.equal(
		done.status,
		"Bought. If it's above $6.39: 0.65 META shares. If not: $500.00 back.",
	);
	const failed = ticketView({
		...base,
		phase: { kind: "failed", problem: { kind: "failed" } },
	});
	assert.equal(
		failed.status,
		"That didn't go through, and nothing moved. Try again.",
	);
	assert.equal(failed.buy.disabled, false);
});

test("an empty amount asks for one", () => {
	const view = ticketView({ ...base, amountCents: undefined });
	assert.equal(view.state, "empty");
	assert.equal(view.buy.disabled, true);
});

test("a quote the chain refuses shows the refusal", () => {
	const view = ticketView({
		...base,
		quote: { problem: { kind: "closed", at: Date.parse(ANNOUNCES) / 1000 } },
	});
	assert.equal(view.state, "closed");
});

test("no state of the ticket uses the vocabulary the product avoids", () => {
	const inputs: TicketInput[] = [
		base,
		{ ...base, yes: false },
		{ ...base, live: false },
		{ ...base, nowMs: Date.parse(ANNOUNCES) },
		{ ...base, account: undefined },
		{ ...base, balanceCents: 0n },
		{ ...base, roomCents: 0n },
		{ ...base, quote: undefined },
		{ ...base, amountCents: undefined },
		{ ...base, phase: { kind: "signing" } },
		{ ...base, phase: { kind: "pending" } },
		{ ...base, phase: { kind: "checking" } },
		{ ...base, phase: { kind: "done", shares: 1n } },
		{ ...base, phase: { kind: "failed", problem: { kind: "moved" } } },
	];
	for (const input of inputs) {
		const view = ticketView(input);
		const words =
			`${view.buy.label} ${view.other} ${view.status}`.toLowerCase();
		for (const word of BANNED)
			assert.doesNotMatch(words, new RegExp(`\\b${word}\\b`), view.state);
	}
});
