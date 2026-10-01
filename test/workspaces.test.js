import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
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
