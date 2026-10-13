import { expect, test } from "@playwright/test";

test("the mark renders at 16, 24 and 128 px with its cut open", async ({
	page,
}) => {
	await page.goto("/catalogue");
	for (const size of [16, 24, 128]) {
		const mark = page
			.locator(`[data-primitive="mark"][data-size="${size}"]`)
			.first();
		await expect(mark).toBeVisible();
		const box = await mark.boundingBox();
		expect(Math.round(box?.width ?? 0)).toBe(size);
		const gap = Number(await mark.getAttribute("data-gap"));
		expect(gap).toBeGreaterThanOrEqual(1);
	}
});
