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

test("the hook accepts Solidity that the project's own formatter produced", () => {
	// Measured, and it cost a rejected commit: run from the repository root the formatter
	// finds no project configuration and falls back to its own defaults, which allow a
	// wider line and therefore demand the opposite of what `pnpm fmt` writes. The hook then
	// rejects the tree the project just formatted, and the only way through is to hand-edit
	// a file to satisfy a configuration nobody chose.
	const scratch = mkdtempSync(path.join(tmpdir(), "hook-ok-"));
	try {
		for (const item of [
			".husky",
			"biome.json",
			"package.json",
			"node_modules",
			"tools",
			"contracts",
		]) {
			cpSync(path.join(root, item), path.join(scratch, item), {
				recursive: true,
			});
		}
		git(["init", "-q", "."], scratch);
		git(["add", "contracts/script/DeployProbe.s.sol"], scratch);

		let code = 0;
		let output = "";
		try {
			output = execFileSync(path.join(scratch, ".husky", "pre-commit"), {
				cwd: scratch,
				encoding: "utf8",
				stdio: "pipe",
			});
		} catch (error) {
			code = error.status ?? 1;
			output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
		}
		assert.equal(
			code,
			0,
			`the hook rejected a file the project formatter produced:\n${output}`,
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("the hook accepts a commit whose only staged file is a generated record", () => {
	// The record is excluded from the formatter so the formatter cannot rewrite what the
	// deploy produced. The other edge of that same decision: with every staged path
	// excluded, the formatter reports that it processed nothing and exits non-zero, so the
	// hook rejects the one commit the pipeline exists to produce. Either way the only route
	// through is a hand edit, inside the hook, on the path of the rule that forbids one.
	const scratch = mkdtempSync(path.join(tmpdir(), "hook-record-"));
	try {
		for (const item of [
			".husky",
			"biome.json",
			"package.json",
			"node_modules",
			"tools",
			"contracts",
		]) {
			cpSync(path.join(root, item), path.join(scratch, item), {
				recursive: true,
			});
		}
		git(["init", "-q", "."], scratch);
		const record = path.join(scratch, "contracts", "deployments", "10143.json");
		execFileSync("mkdir", ["-p", path.dirname(record)]);
		writeFileSync(record, '{\n  "Probe": {\n    "address": "0x00"\n  }\n}\n');
		git(["add", "-f", "contracts/deployments/10143.json"], scratch);

		let code = 0;
		let output = "";
		try {
			output = execFileSync(path.join(scratch, ".husky", "pre-commit"), {
				cwd: scratch,
				encoding: "utf8",
				stdio: "pipe",
			});
		} catch (error) {
			code = error.status ?? 1;
			output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
		}
		assert.equal(code, 0, `the hook rejected a generated record:\n${output}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
