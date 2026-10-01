import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, cwd = root) {
	try {
		return {
			code: 0,
			output: execFileSync(command, args, {
				cwd,
				encoding: "utf8",
				stdio: "pipe",
			}),
		};
	} catch (error) {
		return {
			code: error.status ?? 1,
			output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
		};
	}
}

function scratch() {
	return mkdtempSync(path.join(tmpdir(), "gate-fixture-"));
}

test("the Solidity formatter rejects a badly formatted file and names it", () => {
	const dir = scratch();
	try {
		const bad = path.join(dir, "Ugly.sol");
		writeFileSync(
			bad,
			"// SPDX-License-Identifier: BUSL-1.1\npragma solidity 0.8.26;\ncontract Ugly {uint256 public   v;function f() external {v=1;}}\n",
		);
		const { code, output } = run("forge", ["fmt", "--check", bad]);
		assert.notEqual(code, 0, "the formatter accepted a badly formatted file");
		assert.match(output, /Ugly\.sol/, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the TypeScript gate rejects an unused import and names the file", () => {
	const dir = scratch();
	try {
		const bad = path.join(dir, "bad.ts");
		writeFileSync(
			bad,
			'import { readFileSync } from "node:fs";\nexport const value = 1;\n',
		);
		const { code, output } = run("pnpm", [
			"exec",
			"biome",
			"ci",
			"--error-on-warnings",
			bad,
		]);
		assert.notEqual(code, 0, "the TypeScript gate accepted an unused import");
		assert.match(output, /bad\.ts/, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("both gates pass on the real tree", () => {
	assert.equal(run("forge", ["fmt", "--check", "--root", "contracts"]).code, 0);
	assert.equal(
		run("pnpm", ["exec", "biome", "ci", "--error-on-warnings", "."]).code,
		0,
	);
});

test("the TypeScript gate reports a non-zero count of files inspected", () => {
	// Silently matching nothing is the most common linting misconfiguration there is,
	// and no assertion about configuration text catches it.
	const { output } = run("pnpm", [
		"exec",
		"biome",
		"ci",
		"--error-on-warnings",
		".",
	]);
	const checked = output.match(/Checked (\d+) file/);
	assert.ok(checked, `no file count in output:\n${output}`);
	assert.ok(Number(checked[1]) > 0, "the gate inspected no files");
});

test("the Solidity formatter inspects the test directory, which is the only Solidity there is", () => {
	// contracts/src/ is deliberately absent, so a formatter scoped to src/ would
	// inspect nothing and exit zero.
	const { code, output } = run("forge", [
		"fmt",
		"--check",
		"--root",
		"contracts",
		"test",
	]);
	assert.equal(code, 0, output);
});

test("the documentation gate rejects an undocumented external function", () => {
	// forge lint reports nothing at all on this, which is why a second Solidity tool
	// is justified for the one rule the required toolchain cannot express.
	const dir = path.join(root, "contracts", "test", ".fixture");
	try {
		execFileSync("mkdir", ["-p", dir]);
		const bad = path.join(dir, "Undocumented.sol");
		writeFileSync(
			bad,
			"// SPDX-License-Identifier: BUSL-1.1\npragma solidity 0.8.26;\n\ncontract Undocumented {\n    function store(uint256 v) external returns (uint256) {\n        return v;\n    }\n}\n",
		);

		const lint = run("forge", [
			"lint",
			"-D",
			"warnings",
			"--root",
			"contracts",
			"test/.fixture",
		]);
		assert.equal(
			lint.code,
			0,
			"forge lint unexpectedly reported on missing documentation",
		);

		const { code, output } = run("pnpm", [
			"exec",
			"solhint",
			"--config",
			"contracts/.solhint.json",
			"contracts/test/.fixture/Undocumented.sol",
		]);
		assert.notEqual(
			code,
			0,
			`the documentation gate accepted an undocumented function:\n${output}`,
		);
		assert.match(output, /@notice/, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the documentation gate passes on the real tree and inspects a non-zero count", () => {
	const { code, output } = run("pnpm", [
		"exec",
		"solhint",
		"--config",
		"contracts/.solhint.json",
		"contracts/test/**/*.sol",
	]);
	assert.equal(code, 0, output);
	const files = run("sh", [
		"-c",
		"ls contracts/test/*.sol | wc -l",
	]).output.trim();
	assert.ok(
		Number(files) > 0,
		"the documentation gate had no Solidity to inspect",
	);
});

test("every exported TypeScript symbol carries a documentation comment", async () => {
	// Biome has no rule for documentation presence, so this is a check in the suite.
	const ts = (await import("typescript")).default;
	const config = path.join(root, "web", "tsconfig.json");
	const parsed = ts.parseJsonConfigFileContent(
		ts.readConfigFile(config, ts.sys.readFile).config,
		ts.sys,
		path.dirname(config),
	);
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	const checker = program.getTypeChecker();

	const undocumented = [];
	for (const file of program.getSourceFiles()) {
		if (file.isDeclarationFile) continue;
		if (!file.fileName.includes("/web/src/")) continue;
		const moduleSymbol = checker.getSymbolAtLocation(file);
		if (!moduleSymbol) continue;
		for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
			if (symbol.getDocumentationComment(checker).length === 0) {
				undocumented.push(
					`${path.relative(root, file.fileName)}: ${symbol.getName()}`,
				);
			}
		}
	}
	assert.deepEqual(
		undocumented,
		[],
		`undocumented exports: ${undocumented.join(", ")}`,
	);
});
