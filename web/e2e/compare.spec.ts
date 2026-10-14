import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { bannedWordsOn, sidewaysOverflowOn } from "./words.ts";

test.beforeEach(async ({ page }) => {
	await page.goto("/compare");
});

test("the three ways recompute from what the visitor enters", async ({
	page,
}) => {
	const condition = page.locator('tr[data-way="condition"]');
	await expect(condition).toContainText("$1,000.00 back");
	await page.getByLabel("Amount", { exact: true }).fill("500");
	await expect(condition).toContainText("$500.00 back");
	const call = page.locator('tr[data-way="call"]');
	await expect(call).toContainText("Enter a call option");
	await page.getByLabel("Call option price, per share").fill("5");
	await page.getByLabel("Call option strike").fill("1");
	await expect(call).toContainText("Options on 100 shares");
});

test("the comparison passes the reading checks", async ({ page }) => {
	expect(await bannedWordsOn(page)).toEqual([]);
	expect(await sidewaysOverflowOn(page)).toBe(0);
	const axe = await new AxeBuilder({ page }).analyze();
	expect(axe.violations).toEqual([]);
});
