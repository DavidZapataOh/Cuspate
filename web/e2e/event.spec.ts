import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { formatUnits } from "viem";
import { rpcUrl } from "../src/chain/endpoint.ts";
import { chainClient, quoteShares } from "../src/chain/market.ts";
import { formatChance, formatShares } from "../src/lib/format.ts";
import { about } from "../src/lib/issuer.ts";
import { conditionTitle, formatThreshold } from "../src/lib/naming.ts";
import { duration } from "../src/lib/time.ts";
import { problemText } from "../src/ticket/problems.ts";
import { indexed, read } from "./chain.ts";
import {
	bannedWordsOn,
	sidewaysOverflowOn,
	tabularSeparatorsOn,
} from "./words.ts";

/** The value, or a failed test naming what was missing. */
function must<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`missing: ${what}`);
	return value;
}

const first = async () =>
	must((await read.events(Date.now()))[0], "an event on chain");

test("an event lists every condition with its chance, and choosing one moves the chart and the ticket", async ({
	page,
}) => {
	const event = await first();
	await page.goto(`/events/${event.eventKey}`);
	const rows = page.locator('[data-primitive="ruled-row"]');
	await expect(rows).toHaveCount(event.conditions.length);
	const byThreshold = [...event.conditions].sort((a, b) =>
		a.threshold < b.threshold ? -1 : 1,
	);
	for (const [i, c] of byThreshold.entries())
		await expect(rows.nth(i)).toContainText(`${formatChance(c.chance)} likely`);
	const top = must(byThreshold.at(-1), "a condition");
	const name = conditionTitle(event, top);
	await page
		.getByRole("button", {
			name: new RegExp(`: ${name.replace(/[$.()]/g, "\\$&")}$`),
		})
		.first()
		.click();
	await expect(
		page.getByRole("heading", { name: `Your ticket: ${name}` }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: `Chance: ${name}` }),
	).toBeVisible();
	await expect(page.locator('[data-primitive="line-chart"] svg')).toBeVisible();
});

test("the chart runs from the market's opening to now, and says what it knows of the trades between", async ({
	page,
}) => {
	const event = await first();
	const primary = must(
		event.conditions.find((c) => c.primary),
		"a primary condition",
	);
	const history = await read.history(event.eventKey, primary.key, Date.now());
	await page.goto(`/events/${event.eventKey}`);
	const chart = page.locator('[data-primitive="line-chart"]');
	await expect(chart.locator("tbody tr")).toHaveCount(history.points.length);
	await expect(chart.locator("tbody tr").first()).toContainText("(opened)");
	await expect(chart.locator("tbody tr").last()).toContainText("(now)");
	expect(history.tradesKnown).toBe(indexed);
	if (!indexed)
		await expect(chart).toContainText("The trade history is unavailable");
	else if (!history.points.some((p) => p.source === "trade"))
		await expect(chart).toContainText("No trades yet");
});

test("the ticket shows what an amount buys at the quoter's price, and the dollars back otherwise", async ({
	page,
}) => {
	const event = await first();
	const primary = must(
		event.conditions.find((c) => c.primary),
		"a primary condition",
	);
	const market = must(primary.market, "the primary condition's market");
	await page.goto(`/events/${event.eventKey}`);
	const ticket = page.locator("aside");
	// Typed only once the ticket answers to input, so hydration cannot reset the field.
	await expect(ticket.locator("[data-hydrated]")).toHaveCount(1);
	await ticket.getByRole("textbox", { name: "Amount" }).fill("1000");
	await expect(ticket).toContainText("$1,000.00 back");
	await expect(ticket).toContainText("Fee 0.30% ($3.00), shown either way.");
	await expect(ticket).toContainText(/Until .+ ET, you can undo this\./);
	await expect(ticket).not.toContainText("Getting a price...", {
		timeout: 20_000,
	});
	const quote = await quoteShares(
		chainClient(rpcUrl()),
		market.legs,
		true,
		1000n * 10n ** 6n,
	);
	// The pool may not take the whole amount now; then the ticket says how much it takes.
	if ("shares" in quote)
		await expect(ticket).toContainText(
			`${formatShares(Number(formatUnits(quote.shares, 18)))} ${event.issuer} shares`,
		);
	else await expect(ticket).toContainText(problemText(quote.problem));
});

test("the rules state the exact figure, the strict bound, how a figure is settled and where it stands", async ({
	page,
}) => {
	const events = await read.events(Date.now());
	const settlement = await read.settlement();
	const gaap = must(
		events.find((e) => about(e).figureKind === "gaap-diluted-eps"),
		"a GAAP issuer",
	);
	const primary = must(
		gaap.conditions.find((c) => c.primary),
		"a primary condition",
	);
	await page.goto(`/events/${gaap.eventKey}`);
	const rules = page.locator("section", {
		has: page.getByRole("heading", { name: "Rules" }),
	});
	await expect(rules).toContainText("as reported under GAAP");
	await expect(rules).toContainText(
		`Exactly ${formatThreshold(primary)} does not count.`,
	);
	await expect(rules).toContainText(
		`can be challenged for ${duration(settlement.livenessSeconds)}`,
	);
	if (primary.sealTx)
		await expect(rules).toContainText(primary.sealTx.slice(0, 6));
	const resolution = rules.locator("[data-resolution]");
	if (primary.resolution.rounds.length === 0)
		await expect(resolution).toContainText("No figure has been proposed yet.");
	else
		await expect(resolution.locator("li")).toHaveCount(
			primary.resolution.rounds.length,
		);
	await expect(page.locator("main")).not.toContainText(/expectation/i);
});

test("an event page shows none of the words kept out of the product and has no accessibility violation", async ({
	page,
}) => {
	const event = await first();
	await page.goto(`/events/${event.eventKey}`);
	expect(await bannedWordsOn(page)).toEqual([]);
	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual(
		[],
	);
});

test("an unknown event is not found", async ({ page }) => {
	const response = await page.goto("/events/not-an-event");
	expect(response?.status()).toBe(404);
});

test("every amount on an event page keeps its separators narrow", async ({
	page,
}) => {
	const event = await first();
	await page.goto(`/events/${event.eventKey}`);
	expect(await tabularSeparatorsOn(page)).toEqual([]);
});

test("the event page fits a phone without scrolling sideways", async ({
	page,
}) => {
	const event = await first();
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await page.goto(`/events/${event.eventKey}`);
		expect(await sidewaysOverflowOn(page), `at ${width}px`).toBe(0);
	}
});

test("on a phone the chart's labels stay readable", async ({ page }) => {
	const event = await first();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/events/${event.eventKey}`);
	const heights = await page
		.locator('[data-primitive="line-chart"] svg text')
		.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
	expect(heights.length).toBeGreaterThan(0);
	expect(Math.min(...heights)).toBeGreaterThanOrEqual(11);
});

test("an unknown address says so in a page with its landmarks, and nothing the accessibility engine flags", async ({
	page,
}) => {
	await page.goto("/events/not-an-event");
	await expect(page.locator("main h1")).toHaveText(
		"There is nothing at this address.",
	);
	await expect(
		page.getByRole("link", { name: "See every open market" }),
	).toBeVisible();
	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual(
		[],
	);
});

test("a row's own buttons choose the condition and the world, and the address keeps both", async ({
	page,
}) => {
	const event = await first();
	const top = must(
		[...event.conditions].sort((a, b) =>
			a.threshold < b.threshold ? 1 : -1,
		)[0],
		"a condition",
	);
	const name = conditionTitle(event, top);
	await page.goto(`/events/${event.eventKey}`);
	await expect(page.locator("aside [data-hydrated]")).toHaveCount(1);
	const no = page.getByRole("button", {
		name: new RegExp(
			`^If (not|they don't): ${name.replace(/[$.()]/g, "\\$&")}$`,
		),
	});
	await no.click();
	await expect(no).toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL(new RegExp(`\\?c=${top.key}&side=no$`));
	await expect(
		page.getByRole("heading", { name: `Your ticket: ${name}` }),
	).toBeVisible();
	await expect(page.locator("aside [data-primitive='ticket']")).toContainText(
		/back/,
	);
	await page.reload();
	await expect(
		page.getByRole("heading", { name: `Your ticket: ${name}` }),
	).toBeVisible();
	await expect(no).toHaveAttribute("aria-pressed", "true");
});
