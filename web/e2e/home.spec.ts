import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { filterEvents, pickFeatured } from "../src/lib/events.ts";
import { formatChance, formatUsd } from "../src/lib/format.ts";
import { about } from "../src/lib/issuer.ts";
import { headline } from "../src/lib/naming.ts";
import { read } from "./chain.ts";
import {
	bannedWordsOn,
	sidewaysOverflowOn,
	tabularSeparatorsOn,
} from "./words.ts";

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await page.evaluate(() => document.fonts.ready);
});

/** The text as a visitor reads it, with the figures' thin spaces and line breaks taken out. */
const plain = (text: string) => text.replace(/\s+/g, "");

test("the next event to freeze is featured, with the balance its pools imply and the feed's price", async ({
	page,
}) => {
	const now = Date.now();
	const featured = pickFeatured(await read.events(now), now);
	if (!featured) throw new Error("no open event on chain");
	const primary = featured.conditions.find((c) => c.primary);
	if (!primary) throw new Error("no primary condition");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		headline(featured, primary),
	);
	const scale = page.locator('[data-primitive="balance-scale"]').first();
	await expect(scale).toBeVisible();
	await expect(page.locator('[data-primitive="ticket"]').first()).toBeVisible();
	const caption = plain((await scale.locator("figcaption").innerText()) ?? "");
	expect(caption).toContain(
		plain(
			`${formatUsd(primary.beatPriceCents)} + ${formatUsd(primary.dontPriceCents)}`,
		),
	);
	expect(caption).toContain(
		plain(`The pools imply ${formatUsd(primary.impliedCents)}.`),
	);
	expect(caption).toContain(plain(formatUsd(featured.spotCents)));
});

test("every open event has a card, in the order they freeze, with its chance and money in", async ({
	page,
}) => {
	const now = Date.now();
	const open = filterEvents(await read.events(now), "All", "", now);
	expect(open.length).toBeGreaterThan(0);
	await expect(page.locator("li[data-event]")).toHaveCount(open.length);
	const keys = await page
		.locator("li[data-event]")
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-event")));
	expect(keys).toEqual(open.map((e) => e.eventKey));
	for (const event of open) {
		const card = plain(
			await page.locator(`li[data-event="${event.eventKey}"]`).innerText(),
		);
		const primary = event.conditions.find((c) => c.primary);
		if (primary) expect(card).toContain(plain(formatChance(primary.chance)));
		expect(card).toContain(
			plain(`${formatUsd(event.moneyIn)} test dollars in`),
		);
	}
});

test("a chip and a search narrow the open markets", async ({ page }) => {
	const now = Date.now();
	const events = await read.events(now);
	await page.getByRole("button", { name: "Tech" }).click();
	await expect(page.locator("li[data-event]")).toHaveCount(
		filterEvents(events, "Tech", "", now).length,
	);
	await page.getByRole("button", { name: "All" }).click();
	const first = events[0];
	if (first) {
		const name = about(first).company;
		await page.getByRole("searchbox", { name: "Search markets" }).fill(name);
		await expect(page.locator("li[data-event]")).toHaveCount(
			filterEvents(events, "All", name, now).length,
		);
	}
	await page
		.getByRole("searchbox", { name: "Search markets" })
		.fill("nothing like this");
	await expect(page.getByText("No open market matches that.")).toBeVisible();
});

test("no company that publishes only GAAP EPS is said to beat expectations", async ({
	page,
}) => {
	for (const event of await read.events(Date.now())) {
		if (about(event).figureKind !== "gaap-diluted-eps") continue;
		const card = page.locator(`li[data-event="${event.eventKey}"]`);
		if ((await card.count()) === 0) continue;
		await expect(card).not.toContainText(/expectation|beat/i);
	}
});

test("the page says it runs on a test network, and shows none of the words kept out of the product", async ({
	page,
}) => {
	await expect(
		page.getByText(/Test network: test dollars and test shares/),
	).toBeVisible();
	await expect(page.locator("body")).not.toContainText(/sample data/i);
	expect(await bannedWordsOn(page)).toEqual([]);
});

test("the homepage has no accessibility violation", async ({ page }) => {
	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual(
		[],
	);
});

test("every amount keeps its separators narrow, on the cards and in the balance's caption", async ({
	page,
}) => {
	await expect(page.locator("li[data-event]").first()).toContainText(
		"test dollars in",
	);
	expect(await tabularSeparatorsOn(page)).toEqual([]);
});

test("the homepage fits a phone without scrolling sideways", async ({
	page,
}) => {
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		await page.goto("/");
		expect(await sidewaysOverflowOn(page), `at ${width}px`).toBe(0);
	}
});

test("the footer rule lines up with the page's content", async ({ page }) => {
	for (const width of [1440, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/");
		const content = await page.locator("main h1").first().boundingBox();
		const footer = await page.locator("footer").boundingBox();
		expect(footer?.x, `at ${width}px`).toBe(content?.x);
	}
});

test("the link to the other side carries no box, even while it waits", async ({
	page,
}) => {
	await page.goto("/");
	const border = await page
		.locator('[data-primitive="ticket"] [data-variant="link"]')
		.first()
		.evaluate((el) => getComputedStyle(el).borderTopColor);
	expect(border).toBe("rgba(0, 0, 0, 0)");
});
