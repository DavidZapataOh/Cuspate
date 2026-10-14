import type { Page } from "@playwright/test";
import { BANNED } from "../src/lib/banned.ts";

/** The banned words found in what a visitor reads or hears: visible text and accessible names. */
export async function bannedWordsOn(page: Page): Promise<string[]> {
	const text = await page.evaluate(() => {
		const names = [
			...document.querySelectorAll("[aria-label],[title],[alt]"),
		].map((el) =>
			["aria-label", "title", "alt"]
				.map((a) => el.getAttribute(a) ?? "")
				.join(" "),
		);
		return `${document.body.innerText} ${names.join(" ")}`.toLowerCase();
	});
	return BANNED.filter((word) => new RegExp(`\\b${word}\\b`).test(text));
}

/**
 * Every '.' or ',' that is set with tabular width: the face's tabular separators are as wide as a
 * digit and pull an amount apart ("$18 , 700 . 00"). Figures keep their separators proportional.
 */
export async function tabularSeparatorsOn(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const found: string[] = [];
		const walker = document.createTreeWalker(
			document.body,
			NodeFilter.SHOW_TEXT,
		);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node.textContent ?? "";
			const parent = node.parentElement;
			if (!parent || !/[.,]/.test(text) || parent.closest("[hidden],svg,table"))
				continue;
			if (
				getComputedStyle(parent).fontVariantNumeric.includes("tabular-nums")
			) {
				found.push(`${parent.tagName}: ${text.trim().slice(0, 40)}`);
			}
		}
		return found;
	});
}

/** How far the page reaches past the window sideways, in pixels; 0 means no sideways scroll. */
export async function sidewaysOverflowOn(page: Page): Promise<number> {
	return page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
}
