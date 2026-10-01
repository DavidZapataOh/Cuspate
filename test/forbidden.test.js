import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanner = path.join(root, "tools", "scan-forbidden.sh");

function scan(args, env = {}) {
	try {
		const output = execFileSync(scanner, args, {
			cwd: root,
			encoding: "utf8",
			stdio: "pipe",
			env: { ...process.env, ...env },
		});
		return { code: 0, output };
	} catch (error) {
		return {
			code: error.status ?? 1,
			output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
		};
	}
}

function fixture(name, contents) {
	const dir = mkdtempSync(path.join(tmpdir(), "scan-"));
	const file = path.join(dir, name);
	writeFileSync(file, contents);
	return { dir, file };
}

const classes = [
	["a non-ASCII character", "note.md", "the price of the acción\n"], // scan-allow: deliberately violating fixture
	[
		"a path that escapes the repository root",
		"escape.ts",
		'import x from "../../outside/thing.js";\n', // scan-allow: deliberately violating fixture
	],
	[
		"an absolute path under a home directory",
		"local.md",
		"see /home/someone/notes.txt\n", // scan-allow: deliberately violating fixture
	],
	["a refused public claim", "copy.md", "This is a new primitive.\n"], // scan-allow: deliberately violating fixture
];

for (const [label, name, contents] of classes) {
	test(`the scanner rejects ${label} and names the file`, () => {
		const { dir, file } = fixture(name, contents);
		try {
			const { code, output } = scan([file]);
			assert.notEqual(code, 0, `the scanner accepted ${label}:\n${output}`);
			assert.match(output, new RegExp(name.replace(".", "\\.")), output);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("the scanner rejects a hashed term and never prints it", () => {
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

	const { dir, file } = fixture(
		"leak.md",
		`a sentence holding ${term} in it\n`,
	);
	const hashes = path.join(dir, "hashes.txt");
	writeFileSync(hashes, `${digest}\n`);
	try {
		const { code, output } = scan([file], {
			SCAN_SALT: salt,
			SCAN_HASHES: hashes,
		});
		assert.notEqual(code, 0, `the scanner accepted a hashed term:\n${output}`);
		assert.match(output, /forbidden token/, output);
		assert.doesNotMatch(
			output,
			new RegExp(term),
			"the scanner printed the matched term",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("without a salt the scanner reports partially and passes the hashed class", () => {
	const { dir, file } = fixture(
		"leak.md",
		"a sentence holding unpublishable in it\n",
	);
	try {
		const { code, output } = scan([file], { SCAN_SALT: "" });
		assert.equal(code, 0, output);
		assert.match(output, /partial/i, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the scanner passes over the real tree", () => {
	const { code, output } = scan([]);
	assert.equal(code, 0, output);
});

test("a line carrying the allowance marker is not reported", () => {
	const { dir, file } = fixture(
		"defs.md",
		"This is a new primitive. scan-allow: this line defines the rule\n",
	);
	try {
		const { code, output } = scan([file]);
		assert.equal(code, 0, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the allowance marker does not reach the hashed class", () => {
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

	const { dir, file } = fixture(
		"leak.md",
		`a sentence holding ${term} in it scan-allow: not permitted here\n`,
	);
	const hashes = path.join(dir, "hashes.txt");
	writeFileSync(hashes, `${digest}\n`);
	try {
		const { code, output } = scan([file], {
			SCAN_SALT: salt,
			SCAN_HASHES: hashes,
		});
		assert.notEqual(
			code,
			0,
			`the marker silenced the hashed class:\n${output}`,
		);
		assert.match(output, /forbidden token/, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
