/**
 * A purchase on a fork of the test network, from each place the ticket lives, with a wallet that
 * holds test dollars; and a wallet without them, which gets some from the ticket. Every state the
 * buyer passes through is read for the words the product avoids.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { contracts } from "../../src/chain/record.ts";
import { pickFeatured } from "../../src/lib/events.ts";
import { buttonWords, panLabels } from "../../src/lib/naming.ts";
import { read } from "../chain.ts";
import { bannedWordsOn } from "../words.ts";
import { injectTestWallet, TEST_WALLET_NAME } from "./wallet.ts";

const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? "";
// The condition bought is the homepage's featured one, read from the fork as the server reads it:
// which event leads depends on the money in, which trading moves.
const now = Date.now();
const found = pickFeatured(await read.events(now), now);
const condition = found?.conditions.find((c) => c.primary);
if (!found || !condition?.market)
	throw new Error("no featured condition with a market on the fork");
const featured = found;
const market = condition.market;
const [holds, fails] = panLabels(featured, condition);
const buyLabel = buttonWords(featured, condition, true).buy;
const client = createPublicClient({ transport: http(rpcUrl) });
const balanceOf = parseAbi([
	"function balanceOf(address) view returns (uint256)",
]);
const BUYER = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
// One empty wallet per browser: they share the fork, and a wallet that took its test dollars once
// has to wait a day for more.
const EMPTY: Record<string, `0x${string}`> = {
	chromium: getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906"),
	firefox: getAddress("0x15d34aaf54267db7d7c367839aaf71a00a2c6a65"),
	webkit: getAddress("0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc"),
};

test.describe.configure({ mode: "serial" });

const held = (token: `0x${string}`, owner: `0x${string}`) =>
	client.readContract({
		address: token,
		abi: balanceOf,
		functionName: "balanceOf",
		args: [owner],
	});

async function signIn(page: Page) {
	await page
		.getByRole("button", { name: "Sign in", exact: true })
		.first()
		.click();
	const panel = page.getByRole("dialog", { name: "Sign in" });
	await panel.getByRole("button", { name: TEST_WALLET_NAME }).click();
	await expect(
		page.getByRole("button", { name: /^0x[0-9a-f]{4}\.\.\./i }).first(),
	).toBeVisible();
	await page.keyboard.press("Escape");
}

async function buy(page: Page, ticket: Locator, amount: string) {
	const before = await held(market.legs.underlyingYes, BUYER);
	const kept = await held(market.legs.dollarNo, BUYER);
	await ticket.getByRole("textbox", { name: "Amount" }).fill(amount);
	const status = ticket.locator("[aria-live]");
	await expect(status).toContainText(`${holds}: `);
	await expect(status).toContainText(
		` ${featured?.issuer} shares. ${fails}: $${amount}.00 back.`,
	);
	expect(await bannedWordsOn(page)).toEqual([]);
	await ticket.getByRole("button", { name: buyLabel }).click();
	await expect(status).toContainText(`Bought. ${holds}: `, {
		timeout: 60_000,
	});
	expect(await bannedWordsOn(page)).toEqual([]);
	expect(await held(market.legs.underlyingYes, BUYER)).toBeGreaterThan(before);
	expect(await held(market.legs.dollarNo, BUYER)).toBe(
		kept + BigInt(amount) * 10n ** 6n,
	);
}

test("a wallet with test dollars buys from the homepage's featured ticket", async ({
	page,
}) => {
	await injectTestWallet(page, rpcUrl, BUYER);
	await page.goto("/");
	const ticket = page.locator('[data-primitive="ticket"]').first();
	await expect(ticket).toHaveAttribute("data-hydrated", "true");
	await expect(
		ticket.getByRole("button", { name: "Sign in to buy" }),
	).toBeEnabled();
	expect(await bannedWordsOn(page)).toEqual([]);
	await signIn(page);
	await buy(page, ticket, "500");
});

test("a wallet with test dollars buys from the event page's ticket", async ({
	page,
}) => {
	await injectTestWallet(page, rpcUrl, BUYER);
	await page.goto(`/events/${featured.eventKey}`);
	const ticket = page.locator("aside [data-primitive='ticket']");
	await expect(ticket).toHaveAttribute("data-hydrated", "true");
	await signIn(page);
	await buy(page, ticket, "250");
});

test("a wallet without test dollars is told how many it needs, gets some from the ticket, then can buy", async ({
	page,
	browserName,
}) => {
	const empty = EMPTY[browserName] as `0x${string}`;
	await injectTestWallet(page, rpcUrl, empty);
	await page.goto("/");
	const ticket = page.locator('[data-primitive="ticket"]').first();
	await expect(ticket).toHaveAttribute("data-hydrated", "true");
	await signIn(page);
	const status = ticket.locator("[aria-live]");
	await expect(status).toHaveText(
		"You need $500.00 more. Nothing was charged.",
	);
	expect(await bannedWordsOn(page)).toEqual([]);
	await ticket.getByRole("button", { name: "Get test dollars" }).click();
	await expect(status).toContainText(`${holds}: `, {
		timeout: 60_000,
	});
	expect(await held(contracts.dollar, empty)).toBe(1_000n * 10n ** 6n);
	await expect(ticket.getByRole("button", { name: buyLabel })).toBeEnabled();
});
