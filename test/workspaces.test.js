import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// forge-std ships a real, tracked package.json that is deliberately not a member,
// so the walk excludes it explicitly. "Outside ignored paths" does not cover it.
const excluded = new Set([
	"node_modules",
	"contracts/lib",
	"out",
	"cache",
	".git",
]);

function walkForManifests(dir, relative = "") {
	const found = [];
	for (const entry of readdirSync(dir)) {
		const rel = relative ? `${relative}/${entry}` : entry;
		if (excluded.has(rel) || excluded.has(entry)) continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			found.push(...walkForManifests(full, rel));
		} else if (entry === "package.json") {
			found.push(relative || ".");
		}
	}
	return found;
}

test("the workspace members pnpm reports are the manifests on disk", () => {
	const listed = JSON.parse(
		execFileSync("pnpm", ["-r", "list", "--depth", "-1", "--json"], {
			cwd: root,
			encoding: "utf8",
		}),
	).map((project) => {
		const rel = path.relative(root, project.path);
		return rel === "" ? "." : rel;
	});

	const onDisk = walkForManifests(root);

	assert.deepEqual([...listed].sort(), [...onDisk].sort());
});

test("the workspace exempts no package from the release-age policy", () => {
	// pnpm writes such an exemption into the workspace file itself when an install resolves a
	// package published inside the policy window, so a release too new to trust would pass every
	// later install silently. A package that needs one is pinned to an older release instead.
	const workspace = readFileSync(
		path.join(root, "pnpm-workspace.yaml"),
		"utf8",
	);
	assert.doesNotMatch(workspace, /minimumReleaseAge/);
});

test("no dependency is allowed to run install scripts", () => {
	// A dependency's install script runs arbitrary code on every machine that installs; each one pnpm
	// asks about is declined, by name.
	const workspace = readFileSync(
		path.join(root, "pnpm-workspace.yaml"),
		"utf8",
	);
	const builds = workspace.split(/^allowBuilds:\s*$/m)[1] ?? "";
	const entries = [...builds.matchAll(/^\s+([@\w./-]+):\s*(\S+)\s*$/gm)];
	for (const [, name, allowed] of entries)
		assert.equal(allowed, "false", `${name} may run its install script`);
	assert.doesNotMatch(
		workspace,
		/onlyBuiltDependencies|neverBuiltDependencies|dangerouslyAllowAllBuilds/,
	);
});
