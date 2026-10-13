import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// First-party Solidity only. A naive walk over contracts/ finds vendored sources
// under their own licences plus artefact directories that merely end in .sol.
const firstParty = ["contracts/src", "contracts/test", "contracts/script"];

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

// The test-network contracts are not part of the protocol: they exist only on the test network and
// on local chains, so they carry the licence the rest of the repository uses, with their own copy of
// it beside them.
const testnet = path.join(root, "contracts", "src", "testnet");

/** The licence a first-party Solidity file must declare, by where it lives. */
function licenceOf(file) {
	return file.startsWith(`${testnet}${path.sep}`) ? "MIT" : "BUSL-1.1";
}

test("every first-party Solidity file declares the contracts licence", () => {
	const files = firstParty.flatMap((d) => solidityFiles(path.join(root, d)));
	assert.ok(
		files.length > 0,
		"the walk found no first-party Solidity to check",
	);

	const wrong = files.filter((file) => {
		const first = readFileSync(file, "utf8").split("\n", 1)[0];
		return first !== `// SPDX-License-Identifier: ${licenceOf(file)}`;
	});
	assert.deepEqual(
		wrong.map((f) => path.relative(root, f)),
		[],
	);
});

test("the test-network contracts carry their own copy of the licence they declare", () => {
	const files = solidityFiles(testnet);
	assert.ok(files.length > 0, "no test-network contract exists to check");
	assert.match(
		readFileSync(path.join(testnet, "LICENSE"), "utf8"),
		/^MIT License\n/,
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
		"web/.next",
		"web/next-env.d.ts",
		"web/test-results",
		"web/playwright-report",
		"cre/.build",
		"indexer/.envio",
		"indexer/envio-env.d.ts",
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
