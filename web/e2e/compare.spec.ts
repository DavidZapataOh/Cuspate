import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { formatUsd } from "../src/lib/format.ts";
import { read } from "./chain.ts";
import { bannedWordsOn, sidewaysOverflowOn } from "./words.ts";

test.beforeEach(async ({ page }) => {
	await page.goto("/compare");
});

test("the three ways recompute from what the visitor enters", async ({
	page,
}) => {
	const condition = page.locator('tr[data-way="condition"]');
	await expect(condition).toContainText("$1,000.00 back");
	// Typed again until the calculator answers: a field filled before hydration is reset by it.
	await expect(async () => {
		await page.getByLabel("Amount", { exact: true }).fill("500");
		await expect(condition).toContainText("$500.00 back", { timeout: 1_000 });
	}).toPass();
	const call = page.locator('tr[data-way="call"]');
	await expect(call).toContainText("Enter a call option");
	await page.getByLabel("Call option price, per share").fill("5");
	await page.getByLabel("Call option strike").fill("1");
	await expect(call).toContainText("Options on 100 shares");
});

test("every open condition can be compared, at the feed's price of its stock", async ({
	page,
}) => {
	const now = Date.now();
	const events = (await read.events(now)).filter(
		(e) => Date.parse(e.announcesAt) > now,
	);
	await expect(page.locator("select option")).toHaveCount(
		events.reduce((n, e) => n + e.conditions.length, 0),
	);
	const featured = events.find((e) => e.conditions.some((c) => c.primary));
	if (featured)
		await expect(page.locator('tr[data-way="stock"]')).toContainText(
			formatUsd(featured.spotCents).replace(/\s/g, ""),
		);
});

test("the comparison passes the reading checks", async ({ page }) => {
	expect(await bannedWordsOn(page)).toEqual([]);
	expect(await sidewaysOverflowOn(page)).toBe(0);
	const axe = await new AxeBuilder({ page }).analyze();
	expect(axe.violations).toEqual([]);
});
