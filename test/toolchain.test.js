import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function build(cwd) {
	return execFileSync("forge", ["build", "--root", "contracts", "--force"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

// Contract artefacts only. out/build-info/ is excluded because its file name is
// itself derived from the absolute path, so including it is permanently red.
function artefactHashes(cwd) {
	const out = path.join(cwd, "contracts", "out");
	const hashes = new Map();
	for (const entry of readdirSync(out)) {
		if (!entry.endsWith(".sol")) continue;
		const dir = path.join(out, entry);
		if (!statSync(dir).isDirectory()) continue;
		for (const file of readdirSync(dir)) {
			const digest = createHash("sha256")
				.update(readFileSync(path.join(dir, file)))
				.digest("hex");
			hashes.set(`${entry}/${file}`, digest);
		}
	}
	return hashes;
}

test("the contract build is byte-reproducible from a different absolute path", () => {
	const here = artefactHashes(root);
	assert.ok(
		here.size > 0,
		"the build produced no contract artefacts to compare",
	);

	rmSync(path.join(root, "contracts", "out"), { recursive: true, force: true });
	rmSync(path.join(root, "contracts", "cache"), {
		recursive: true,
		force: true,
	});

	const elsewhere = path.join(
		mkdtempSync(path.join(tmpdir(), "reproduce-")),
		"nested",
		"deeper",
	);
	cpSync(root, elsewhere, { recursive: true });
	try {
		build(elsewhere);
		assert.deepEqual(
			artefactHashes(elsewhere),
			here,
			"artefacts differ across absolute paths",
		);
	} finally {
		rmSync(elsewhere, { recursive: true, force: true });
		build(root);
	}
});

test("the build reports no unknown configuration key", () => {
	// Foundry reports an unrecognised key as a warning and builds anyway, so a typo
	// would otherwise be silent and permanent.
	const output = build(root);
	assert.doesNotMatch(output, /Found unknown/, output);
});

// Every pin has exactly one home, and the assertion compares it against what the
// tool itself reports. A pin that only a file knows about is not a pin.
function reported(command, args) {
	return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

test("the pinned Node version is the one Node reports", () => {
	const pinned = readFileSync(path.join(root, ".node-version"), "utf8").trim();
	assert.equal(reported("node", ["--version"]), `v${pinned}`);
});

test("the pinned package manager is the one it reports", () => {
	const { packageManager } = JSON.parse(
		readFileSync(path.join(root, "package.json"), "utf8"),
	);
	const [name, pinned] = packageManager.split("@");
	assert.equal(reported(name, ["--version"]), pinned);
});

test("the pinned Foundry version is the one Foundry reports", () => {
	const pinned = readFileSync(
		path.join(root, ".foundry-version"),
		"utf8",
	).trim();
	assert.match(
		reported("forge", ["--version"]),
		new RegExp(`forge Version: ${pinned}\\b`),
	);
});

test("the pinned compiler is the one that produced the artefacts", () => {
	const pinned = readFileSync(
		path.join(root, "contracts", "foundry.toml"),
		"utf8",
	).match(/^solc = "([^"]+)"$/m)[1];
	const out = path.join(root, "contracts", "out");
	const dir = readdirSync(out).find((e) => e.endsWith(".sol"));
	const file = readdirSync(path.join(out, dir)).find((f) =>
		f.endsWith(".json"),
	);
	const artefact = JSON.parse(readFileSync(path.join(out, dir, file), "utf8"));
	assert.equal(artefact.metadata.compiler.version.split("+")[0], pinned);
});
