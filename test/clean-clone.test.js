import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a clean clone builds every workspace with an emptied environment", () => {
	const script = path.join(root, "tools", "clean-clone.sh");
	assert.ok(existsSync(script), `${script} does not exist`);

	const output = execFileSync(script, { cwd: root, encoding: "utf8" });

	assert.match(
		output,
		/^BUILT contracts$/m,
		"the script did not report building contracts",
	);
	assert.match(
		output,
		/^BUILT web$/m,
		"the script did not report building web",
	);
});

test("a clean clone builds on a machine that has never compiled anything", () => {
	// Measured on the first run on a machine that was not the author's: the build is offline so
	// that anything the clone fails to provide fails loudly, and a machine's first build has no
	// compiler yet, so it failed with the compiler missing. An empty home directory is that machine.
	const home = mkdtempSync(path.join(tmpdir(), "cold-home-"));
	try {
		const output = execFileSync(path.join(root, "tools", "clean-clone.sh"), {
			cwd: root,
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: home },
		});
		assert.match(output, /^BUILT contracts$/m, output);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the dependency revision is pinned by tracked files", () => {
	const tracked = execFileSync("git", ["ls-files"], {
		cwd: root,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean);

	assert.ok(
		tracked.includes("contracts/foundry.lock"),
		"contracts/foundry.lock is not tracked, so the dependency revision floats",
	);
	assert.ok(
		tracked.some((p) => p.endsWith(".gitmodules")),
		"no .gitmodules is tracked, so the submodule is not registered",
	);
});
