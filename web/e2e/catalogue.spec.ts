import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { palette } from "../src/lib/palette.ts";

/** Every primitive the catalogue must render, by the name each carries in `data-primitive`. */
const PRIMITIVES = [
	"mark",
	"wordmark",
	"divided-disc",
	"balance-scale",
	"button",
	"card",
	"amount",
	"countdown",
	"chance-bar",
	"outcome-label",
	"amount-input",
	"tabs",
	"filter-chips",
	"notice",
	"ruled-row",
	"search-field",
	"line-chart",
	"top-bar",
	"footer",
	"trade",
	"ticket",
];

/** The CSS colour string browsers compute for an opaque hex. */
function rgb(hex: string): string {
	const [r, g, b] = [1, 3, 5].map((i) =>
		Number.parseInt(hex.slice(i, i + 2), 16),
	);
	return `rgb(${r}, ${g}, ${b})`;
}

test.beforeEach(async ({ page }) => {
	await page.goto("/catalogue");
	await page.evaluate(() => document.fonts.ready);
});

test("every primitive renders", async ({ page }) => {
	for (const name of PRIMITIVES) {
		await expect(
			page.locator(`[data-primitive="${name}"]`).first(),
			name,
		).toBeVisible();
	}
});

test("the computed colours are the tokens", async ({ page }) => {
	const body = page.locator("body");
	await expect(body).toHaveCSS("background-color", rgb(palette.bg));
	await expect(body).toHaveCSS("color", rgb(palette.text));
	const primary = page
		.locator('[data-primitive="button"][data-variant="primary"]')
		.first();
	await expect(primary).toHaveCSS("background-color", rgb(palette.amber));
	await expect(primary).toHaveCSS("color", rgb(palette.bg));
	await expect(page.locator('[data-primitive="card"]').first()).toHaveCSS(
		"background-color",
		rgb(palette.surface),
	);
	await expect(
		page
			.locator('[data-primitive="outcome-label"][data-outcome="beat"]')
			.first(),
	).toHaveCSS("color", rgb(palette.text));
	await expect(
		page
			.locator('[data-primitive="outcome-label"][data-outcome="dont"]')
			.first(),
	).toHaveCSS("color", rgb(palette.stone));
});

test("the interface's face is the self-hosted one, with tabular figures in amounts", async ({
	page,
}) => {
	const family = await page
		.locator("body")
		.evaluate((el) => getComputedStyle(el).fontFamily);
	const first = (family.split(",")[0] ?? "").replaceAll('"', "").trim();
	expect(first).toMatch(/schibsted/i);
	// Loaded from the site itself, not substituted by a fallback.
	const loaded = await page.evaluate(
		(name) =>
			[...document.fonts].some(
				(face) =>
					face.family.replaceAll('"', "") === name && face.status === "loaded",
			),
		first,
	);
	expect(loaded).toBe(true);
	await expect(
		page.locator('[data-primitive="amount"][data-size="1"]').first(),
	).toHaveCSS("font-variant-numeric", /tabular-nums/);
	await expect(page.locator('[data-primitive="countdown"]').first()).toHaveCSS(
		"font-variant-numeric",
		/tabular-nums/,
	);
});

test("in a tabular amount the digits are tabular and the separators keep their natural width", async ({
	page,
}) => {
	const amount = page
		.locator('[data-primitive="amount"][data-size="1"]')
		.first();
	await expect(amount).toHaveText("$500.00");
	const widths = await amount.evaluate((el) => {
		const style = getComputedStyle(el);
		const measure = (text: string, numeric: string) => {
			const probe = document.createElement("span");
			probe.textContent = text;
			probe.style.font = style.font;
			probe.style.fontVariantNumeric = numeric;
			probe.style.letterSpacing = style.letterSpacing;
			probe.style.whiteSpace = "pre";
			document.body.append(probe);
			const width = probe.getBoundingClientRect().width;
			probe.remove();
			return width;
		};
		return {
			rendered: el.getBoundingClientRect().width,
			digitsTabularSeparatorsNatural:
				measure("$500", "tabular-nums") +
				measure(".", "normal") +
				measure("00", "tabular-nums"),
		};
	});
	expect(
		Math.abs(widths.rendered - widths.digitsTabularSeparatorsNatural),
	).toBeLessThan(0.75);
});

test("the accessibility engine reports no violation, contrast included", async ({
	page,
}) => {
	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual(
		[],
	);
});

test("splitting slides the small part of the disc along the cut", async ({
	page,
}) => {
	const part = page
		.locator(
			'[data-primitive="divided-disc"][data-state="split"] [data-part="small"]',
		)
		.first();
	await expect(part).not.toHaveCSS("transform", "none");
});

test("with reduced motion, nothing moves: the split is shown by opacity alone", async ({
	browser,
}) => {
	const context = await browser.newContext({ reducedMotion: "reduce" });
	const page = await context.newPage();
	await page.goto("/catalogue");
	const part = page
		.locator(
			'[data-primitive="divided-disc"][data-state="split"] [data-part="small"]',
		)
		.first();
	await expect(part).toHaveCSS("transform", "none");
	await expect(part).not.toHaveCSS("opacity", "1");
	await context.close();
});

test("resolving fades the losing part out and keeps the winner", async ({
	page,
}) => {
	const yes = page
		.locator('[data-primitive="divided-disc"][data-state="resolved-yes"]')
		.first();
	await expect(yes.locator('[data-part="small"]')).toHaveCSS("opacity", "0");
	await expect(yes.locator('[data-part="large"]')).toHaveCSS("opacity", "1");
	const no = page
		.locator('[data-primitive="divided-disc"][data-state="resolved-no"]')
		.first();
	await expect(no.locator('[data-part="large"]')).toHaveCSS("opacity", "0");
});

test("the beam tilts toward the likelier side, by a small angle", async ({
	page,
}) => {
	const beams = page.locator(
		'[data-primitive="balance-scale"] [data-part="beam"]',
	);
	const angles = await beams.evaluateAll((els) =>
		els.map((el) => Number(el.getAttribute("data-angle"))),
	);
	expect(angles.length).toBeGreaterThan(1);
	for (const angle of angles) expect(Math.abs(angle)).toBeLessThanOrEqual(4);
	expect(angles.some((a) => a < 0)).toBe(true);
});

test("the balance adds the two worlds into the price the pools imply, beside the stock's own price", async ({
	page,
}) => {
	const scale = page.locator('[data-primitive="balance-scale"]').first();
	await expect(scale).toContainText("The pools imply $100.00.");
	await expect(scale).toContainText(
		"Tesla trades at $99.80 on the price feed.",
	);
	await expect(scale).not.toContainText("real price");
});

test("the pans are named by the condition, not fixed words", async ({
	page,
}) => {
	const labels = page.locator(
		'[data-primitive="balance-scale"] [data-primitive="outcome-label"]',
	);
	await expect(
		labels.filter({ hasText: "If it's above $0.48" }),
	).not.toHaveCount(0);
	await expect(labels.filter({ hasText: "If not" })).not.toHaveCount(0);
});

test("a disabled button cannot be pressed, and every control shows a visible focus ring", async ({
	page,
}) => {
	await expect(
		page.locator('[data-primitive="button"][data-state="disabled"]').first(),
	).toBeDisabled();
	const primary = page
		.locator('[data-primitive="button"][data-variant="primary"]')
		.first();
	await primary.focus();
	const outline = await primary.evaluate(
		(el) => getComputedStyle(el).outlineStyle,
	);
	expect(outline).not.toBe("none");
});

test("an error says what happened with an icon and words, never colour alone", async ({
	page,
}) => {
	const error = page
		.locator('[data-primitive="notice"][data-tone="error"]')
		.first();
	await expect(error.locator("svg")).toHaveCount(1);
	await expect(error).toContainText(/nothing moved|Nothing was charged/);
});

test("the catalogue looks as it did", async ({ page }) => {
	// The countdowns count real time, so they are masked; everything else must match. They are
	// written once the page runs in the browser, so the picture waits for them.
	for (const countdown of await page
		.locator('[data-primitive="countdown"]')
		.all())
		await expect(countdown).not.toBeEmpty();
	await expect(page).toHaveScreenshot("catalogue.png", {
		fullPage: true,
		mask: [page.locator('[data-primitive="countdown"]')],
	});
});
