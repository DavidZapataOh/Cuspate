import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fonts = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../src/fonts",
);

test("the interface's face is self-hosted, as a WOFF2 file", () => {
	const file = path.join(fonts, "SchibstedGrotesk-Variable.woff2");
	assert.ok(existsSync(file));
	assert.equal(readFileSync(file).subarray(0, 4).toString("latin1"), "wOF2");
});

test("the face ships beside its licence", () => {
	const licence = readFileSync(path.join(fonts, "OFL.txt"), "utf8");
	assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/);
});
