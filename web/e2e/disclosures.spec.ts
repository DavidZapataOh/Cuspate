import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { formatChance } from "../src/lib/format.ts";
import { keys } from "../src/lib/keys.ts";
import { read } from "./chain.ts";
import { bannedWordsOn, sidewaysOverflowOn } from "./words.ts";

test.beforeEach(async ({ page }) => {
	await page.goto("/disclosures");
});

test("the disclosures say what this is and who holds the keys", async ({
	page,
}) => {
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"Disclosures",
	);
	await expect(page.locator("main")).toContainText("no real value");
	await expect(page.locator("main")).toContainText("not investment advice");
	for (const k of keys()) {
		await expect(page.locator(`tr[data-role="${k.role}"] a`)).toHaveAttribute(
			"href",
			new RegExp(k.address),
		);
	}
	const now = Date.now();
	const open = (await read.events(now)).filter(
		(e) => Date.parse(e.announcesAt) > now,
	);
	const conditions = open.flatMap((e) => e.conditions);
	await expect(page.locator("tr[data-condition]")).toHaveCount(
		conditions.length,
	);
	for (const c of conditions) {
		const row = page.locator("tr[data-condition]", {
			hasText: c.sealTx?.slice(0, 6) ?? "",
		});
		await expect(row.first()).toContainText(formatChance(c.chance));
	}
});

test("the disclosures pass the reading checks", async ({ page }) => {
	expect(await bannedWordsOn(page)).toEqual([]);
	expect(await sidewaysOverflowOn(page)).toBe(0);
	const axe = await new AxeBuilder({ page }).analyze();
	expect(axe.violations).toEqual([]);
});
