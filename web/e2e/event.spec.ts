import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { fixtures } from "../src/data/fixtures.ts";
import { about } from "../src/lib/issuer.ts";
import { conditionTitle } from "../src/lib/naming.ts";
import {
	bannedWordsOn,
	sidewaysOverflowOn,
	tabularSeparatorsOn,
} from "./words.ts";

const now = Date.now();

/** The value, or a failed test naming what was missing. */
function must<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`missing: ${what}`);
	return value;
}

test("an event lists every condition with its chance, and choosing one moves the chart and the ticket", async ({
	page,
}) => {
	const event = must((await fixtures.events(now))[0], "an event");
	await page.goto(`/events/${event.eventKey}`);
	await expect(page.locator('[data-primitive="ruled-row"]')).toHaveCount(
		event.conditions.length,
	);
	const top = must(
		[...event.conditions].sort((a, b) => Number(b.threshold - a.threshold))[0],
		"a condition",
	);
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

test("the ticket says what an amount ends as in each world", async ({
	page,
}) => {
	const event = must((await fixtures.events(now))[0], "an event");
	await page.goto(`/events/${event.eventKey}`);
	const ticket = page.locator("aside");
	// Typed only once the ticket answers to input, so hydration cannot reset the field.
	await expect(ticket.locator("[data-hydrated]")).toHaveCount(1);
	await ticket.getByRole("textbox", { name: "Amount" }).fill("1000");
	await expect(ticket).toContainText("$1,000.00 back");
	await expect(ticket).toContainText("Fee 0.30% ($3.00), shown either way.");
	await expect(ticket).toContainText(/Until .+ ET, you can undo this\./);
	await expect(
		ticket.locator('[data-primitive="button"][data-variant="primary"]'),
	).toBeDisabled();
	await expect(ticket).toContainText("Buying opens once this market is live.");
});

test("the rules state the exact figure, the strict bound and how a figure is settled", async ({
	page,
}) => {
	const events = await fixtures.events(now);
	const gaap = must(
		events.find((e) => about(e).figureKind === "gaap-diluted-eps"),
		"a GAAP issuer",
	);
	await page.goto(`/events/${gaap.eventKey}`);
	const rules = page.locator("section", {
		has: page.getByRole("heading", { name: "Rules" }),
	});
	await expect(rules).toContainText("as reported under GAAP");
	await expect(rules).toContainText(/Exactly \$\d+\.\d{2} does not count\./);
	await expect(rules).toContainText("can be challenged for 10 minutes");
	await expect(page.locator("main")).not.toContainText(/expectation/i);
});

test("an event page shows none of the words kept out of the product and has no accessibility violation", async ({
	page,
}) => {
	const event = must((await fixtures.events(now))[0], "an event");
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
	const event = must((await fixtures.events(now))[0], "an event");
	await page.goto(`/events/${event.eventKey}`);
	expect(await tabularSeparatorsOn(page)).toEqual([]);
});

test("the event page fits a phone without scrolling sideways", async ({
	page,
}) => {
	const event = must((await fixtures.events(now))[0], "an event");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/events/${event.eventKey}`);
	expect(await sidewaysOverflowOn(page)).toBe(0);
});

test("on a phone the chart's labels stay readable", async ({ page }) => {
	const event = must((await fixtures.events(now))[0], "an event");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/events/${event.eventKey}`);
	const heights = await page
		.locator('[data-primitive="line-chart"] svg text')
		.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
	expect(heights.length).toBeGreaterThan(0);
	expect(Math.min(...heights)).toBeGreaterThanOrEqual(11);
});
