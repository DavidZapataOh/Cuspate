import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	accessSync,
	constants,
	cpSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("git is pointed at a hooks path", () => {
	const configured = git(["config", "--get", "core.hooksPath"], root);
	assert.notEqual(
		configured,
		"",
		"core.hooksPath is unset, so no hook runs on a commit",
	);
});

test("the tracked hook body exists and is executable", () => {
	const hook = path.join(root, ".husky", "pre-commit");
	assert.ok(existsSync(hook), `${hook} does not exist`);
	accessSync(hook, constants.X_OK);
});

test("the hook refuses a badly formatted staged file and leaves it byte-identical", () => {
	// Exercised in a throwaway repository so the real index is never touched.
	const scratch = mkdtempSync(path.join(tmpdir(), "hook-"));
	try {
		for (const item of [
			".husky",
			"biome.json",
			"package.json",
			"node_modules",
			"contracts",
		]) {
			cpSync(path.join(root, item), path.join(scratch, item), {
				recursive: true,
			});
		}
		git(["init", "-q", "."], scratch);
		const bad = path.join(scratch, "bad.ts");
		writeFileSync(
			bad,
			'import { readFileSync } from "node:fs";\nexport const value   =  1;\n',
		);
		git(["add", "bad.ts"], scratch);

		const before = git(["show", ":bad.ts"], scratch);

		let code = 0;
		try {
			execFileSync(path.join(scratch, ".husky", "pre-commit"), {
				cwd: scratch,
				stdio: "pipe",
			});
		} catch (error) {
			code = error.status ?? 1;
		}
		assert.notEqual(code, 0, "the hook accepted a badly formatted staged file");

		const after = git(["show", ":bad.ts"], scratch);
		assert.equal(
			after,
			before,
			"the hook rewrote the staged content instead of reporting on it",
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("the install step succeeds where there is no repository", () => {
	// Hook installation inside the clean-clone's checkout must not break it.
	const scratch = mkdtempSync(path.join(tmpdir(), "no-git-"));
	try {
		cpSync(path.join(root, "package.json"), path.join(scratch, "package.json"));
		cpSync(
			path.join(root, "node_modules"),
			path.join(scratch, "node_modules"),
			{ recursive: true },
		);
		const { scripts } = JSON.parse(
			execFileSync("cat", [path.join(root, "package.json")], {
				encoding: "utf8",
			}),
		);
		execFileSync("sh", ["-c", scripts.prepare], {
			cwd: scratch,
			stdio: "pipe",
		});
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
