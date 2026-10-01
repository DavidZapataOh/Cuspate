import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contracts = path.join(root, "contracts");
const target = "script/DeployProbe.s.sol:Probe";
const big = 128 * 1024 * 1024;

/** The compiler the project pins, resolved from the pin rather than from a path. */
function pinnedSolc() {
	const toml = readFileSync(path.join(contracts, "foundry.toml"), "utf8");
	const version = toml.match(/^solc = "([0-9.]+)"/m)[1];
	return path.join(process.env.HOME, ".svm", version, `solc-${version}`);
}

function inputAt(dir) {
	return execFileSync(
		"forge",
		[
			"verify-contract",
			"--show-standard-json-input",
			"0x0000000000000000000000000000000000000001",
			target,
		],
		{ cwd: dir, encoding: "utf8", maxBuffer: big },
	);
}

test("the verification input recompiles to the creation bytecode this repository ships", () => {
	// Source verification is exactly this equality. Everything else about it is an HTTP
	// call, which is why this is proven without the verifier.
	const compiled = JSON.parse(
		execFileSync(pinnedSolc(), ["--standard-json"], {
			input: inputAt(contracts),
			encoding: "utf8",
			maxBuffer: big,
		}),
	);
	const recompiled =
		compiled.contracts["script/DeployProbe.s.sol"].Probe.evm.bytecode.object;
	const shipped = JSON.parse(
		readFileSync(
			path.join(contracts, "out", "DeployProbe.s.sol", "Probe.json"),
			"utf8",
		),
	).bytecode.object;
	assert.equal(`0x${recompiled}`, shipped);
});

test("the verification input is byte-identical from two different absolute paths", () => {
	const dirs = [
		mkdtempSync(path.join(tmpdir(), "vi-a-")),
		mkdtempSync(path.join(tmpdir(), "vi-b-")),
	];
	try {
		const produced = dirs.map((dir) => {
			cpSync(contracts, path.join(dir, "contracts"), { recursive: true });
			return inputAt(path.join(dir, "contracts"));
		});
		assert.equal(produced[0], produced[1]);
	} finally {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	}
});

test("the scanner reads a term hidden inside the input's escaped source strings", () => {
	const salt = "test-salt";
	const term = "unpublishable";
	const digest = execFileSync(
		"python3",
		[
			"-c",
			`import hmac,hashlib;print(hmac.new(b"${salt}", b"${term}", hashlib.sha256).hexdigest())`,
		],
		{ encoding: "utf8" },
	).trim();

	const input = JSON.parse(inputAt(contracts));
	const first = Object.keys(input.sources)[0];
	// Placed immediately after a newline inside the string, which is where a tokeniser
	// reading the raw file sees one longer word and lets the term through.
	input.sources[first].content = `${input.sources[first].content}\n${term}\n`;

	const dir = mkdtempSync(path.join(tmpdir(), "vi-scan-"));
	try {
		const file = path.join(dir, "input.json");
		const hashes = path.join(dir, "hashes.txt");
		writeFileSync(file, JSON.stringify(input));
		writeFileSync(hashes, `${digest}\n`);

		let code = 0;
		let output = "";
		try {
			output = execFileSync(
				path.join(root, "tools", "scan-forbidden.sh"),
				[file],
				{
					cwd: root,
					encoding: "utf8",
					stdio: "pipe",
					env: { ...process.env, SCAN_SALT: salt, SCAN_HASHES: hashes },
					maxBuffer: big,
				},
			);
		} catch (error) {
			code = error.status ?? 1;
			output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
		}
		assert.notEqual(code, 0, `the planted term was not found:\n${output}`);
		assert.match(output, /forbidden token/, output);
		assert.doesNotMatch(
			output,
			new RegExp(term),
			"the scanner printed the term",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
