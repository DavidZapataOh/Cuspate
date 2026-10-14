import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { bannedWordsOn, sidewaysOverflowOn } from "./words.ts";

// The server reads every recorded market; an address nobody uses holds nothing in any of them.

test("signed out, the portfolio asks to sign in", async ({ page }) => {
	await page.goto("/portfolio");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Portfolio");
	await expect(page.locator('[data-state="signed-out"]')).toContainText(
		"Sign in to see your positions.",
	);
	await expect(
		page.getByRole("navigation", { name: "Main" }).getByRole("link", {
			name: "Portfolio",
		}),
	).toBeVisible();
});

test("an address with no positions says so and links to the markets", async ({
	page,
}) => {
	await page.goto(
		"/portfolio?address=0x2222222222222222222222222222222222222222",
	);
	await expect(page.locator('[data-state="empty"]')).toContainText(
		"No positions yet.",
	);
	await expect(page.getByText("0x2222...2222")).toBeVisible();
	const results = await new AxeBuilder({ page }).analyze();
	expect(results.violations).toEqual([]);
	expect(await bannedWordsOn(page)).toEqual([]);
	expect(await sidewaysOverflowOn(page)).toBe(0);
});

test("a malformed address is named as the problem", async ({ page }) => {
	await page.goto("/portfolio?address=0x123");
	await expect(
		page.locator('[data-primitive="notice"][role="alert"]'),
	).toContainText("That is not an address");
});
