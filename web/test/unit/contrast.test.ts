import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { contrastRatio } from "../../src/lib/contrast.ts";
import { palette } from "../../src/lib/palette.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(path.join(here, "../../app/tokens.css"), "utf8");

/** The value a custom property is declared with in the token sheet. */
function declared(name: string): string | undefined {
	return tokens
		.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]
		?.trim()
		.toUpperCase();
}

test("the contrast of black on white is the maximum, 21:1", () => {
	assert.equal(contrastRatio("#000000", "#FFFFFF").toFixed(2), "21.00");
	assert.equal(contrastRatio("#FFFFFF", "#FFFFFF").toFixed(2), "1.00");
});

test("the contrast ratio is symmetric", () => {
	assert.equal(
		contrastRatio(palette.amber, palette.bg),
		contrastRatio(palette.bg, palette.amber),
	);
});

test("every colour token in the sheet is the palette's, as an opaque hex", () => {
	for (const [name, value] of Object.entries(palette)) {
		assert.equal(declared(name), value, `--${name}`);
		assert.match(value, /^#[0-9A-F]{6}$/, `--${name} is not an opaque hex`);
	}
});

test("text on every surface reads at AA: 4.5:1 or better", () => {
	const surfaces = {
		bg: palette.bg,
		surface: palette.surface,
		"surface-2": palette["surface-2"],
	};
	const inks = {
		text: palette.text,
		"text-muted": palette["text-muted"],
		amber: palette.amber,
		stone: palette.stone,
		error: palette.error,
	};
	for (const [surfaceName, surface] of Object.entries(surfaces)) {
		for (const [inkName, ink] of Object.entries(inks)) {
			const ratio = contrastRatio(ink, surface);
			assert.ok(
				ratio >= 4.5,
				`${inkName} on ${surfaceName} is ${ratio.toFixed(2)}:1`,
			);
		}
	}
});

test("the primary button's label reads on amber", () => {
	assert.ok(contrastRatio(palette.bg, palette.amber) >= 4.5);
});

test("the two outcomes are told apart by more than colour, and neither is red or green", () => {
	// Cream and stone are two states of one object. Hue alone never carries the difference, so the
	// labels say which outcome they are; this guards the hue family itself.
	for (const value of [palette.text, palette.stone]) {
		const [r, g, b] = [1, 3, 5].map((i) =>
			Number.parseInt(value.slice(i, i + 2), 16),
		) as [number, number, number];
		assert.ok(
			Math.abs(r - g) < 40 && Math.abs(g - b) < 40,
			`${value} is not a warm neutral`,
		);
	}
});
