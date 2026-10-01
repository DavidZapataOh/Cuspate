import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// First-party Solidity only. A naive walk over contracts/ finds vendored sources
// under their own licences plus artefact directories that merely end in .sol.
const firstParty = ["contracts/src", "contracts/test"];

function solidityFiles(dir) {
	if (!existsSync(dir)) return [];
	const found = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) found.push(...solidityFiles(full));
		else if (entry.endsWith(".sol")) found.push(full);
	}
	return found;
}

test("every first-party Solidity file declares the contracts licence", () => {
	const files = firstParty.flatMap((d) => solidityFiles(path.join(root, d)));
	assert.ok(
		files.length > 0,
		"the walk found no first-party Solidity to check",
	);

	const wrong = files.filter((file) => {
		const first = readFileSync(file, "utf8").split("\n", 1)[0];
		return first !== "// SPDX-License-Identifier: BUSL-1.1";
	});
	assert.deepEqual(
		wrong.map((f) => path.relative(root, f)),
		[],
	);
});

test("no build output or local environment file is tracked", () => {
	// Checked against git itself rather than against the ignore file's text, so it
	// also catches a file already tracked before its rule was written.
	const patterns = [
		"contracts/out",
		"contracts/cache",
		"contracts/broadcast",
		"node_modules",
		"web/dist",
		".env",
	];
	for (const pattern of patterns) {
		const tracked = execFileSync("git", ["ls-files", "--", pattern], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		assert.equal(tracked, "", `${pattern} is tracked:\n${tracked}`);
	}
});
