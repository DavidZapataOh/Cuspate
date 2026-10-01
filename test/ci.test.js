import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contracts = path.join(root, "contracts");
const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
const big = 256 * 1024 * 1024;

const HEADER =
	"// SPDX-License-Identifier: BUSL-1.1\npragma solidity 0.8.26;\n\n";
const UNIT_GLOB = "test/{unit/*,Toolchain.t.sol}";

// The files the declared list may ever name. It may only shrink: adding a fifth means editing
// this line, which is the decision the list exists to make visible.
const NOT_PROTOCOL_CEILING = [
	"contracts/script/AddressBook.sol",
	"contracts/script/DeployProbe.s.sol",
	"contracts/test/helpers/Ledger.sol",
	"contracts/test/invariant/LedgerHandler.sol",
];

function read(file) {
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** An array the gate script declares, read from the script itself. */
function declared(name) {
	const match = read(path.join(root, "tools", "ci.sh")).match(
		new RegExp(`^${name}=\\(([^)]*)\\)`, "m"),
	);
	return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: big,
		...options,
	});
	return {
		code: result.status ?? 1,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

function gate(name, tree = root, env = {}) {
	return run(path.join(tree, "tools", "ci.sh"), [name], {
		cwd: tree,
		env: { ...process.env, ...env },
	});
}

/** First-party Solidity that is not a test file: the open set the tripwires range over. */
function firstPartyContracts() {
	const found = [];
	const skip = new Set(["lib", "out", "cache", "broadcast"]);
	const walk = (relative) => {
		for (const entry of readdirSync(path.join(root, relative))) {
			const next = path.join(relative, entry);
			const full = path.join(root, next);
			if (statSync(full).isDirectory()) {
				if (relative === "contracts" && skip.has(entry)) continue;
				walk(next);
			} else if (entry.endsWith(".sol") && !entry.endsWith(".t.sol")) {
				found.push(next);
			}
		}
	};
	walk("contracts");
	return found.sort();
}

function subjects() {
	const notProtocol = new Set(declared("NOT_PROTOCOL"));
	return firstPartyContracts().filter((file) => !notProtocol.has(file));
}

/** A throwaway tree carrying the pinned configuration and the tools, and nothing else. */
function scratch() {
	const dir = mkdtempSync(path.join(tmpdir(), "ci-fixture-"));
	cpSync(path.join(root, "tools"), path.join(dir, "tools"), {
		recursive: true,
	});
	for (const file of ["package.json", "biome.json"]) {
		cpSync(path.join(root, file), path.join(dir, file));
	}
	symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
	mkdirSync(path.join(dir, "contracts", "test"), { recursive: true });
	for (const file of [
		"foundry.toml",
		"remappings.txt",
		".solhint.json",
		".solhintignore",
	]) {
		cpSync(path.join(contracts, file), path.join(dir, "contracts", file));
	}
	symlinkSync(path.join(contracts, "lib"), path.join(dir, "contracts", "lib"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	return dir;
}

function plant(dir, relative, content) {
	const file = path.join(dir, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function setKey(dir, key, value) {
	const file = path.join(dir, "contracts", "foundry.toml");
	let text = readFileSync(file, "utf8");
	const line = `${key} = ${value}`;
	text = new RegExp(`^${key}\\s*=`, "m").test(text)
		? text.replace(new RegExp(`^${key}\\s*=.*$`, "m"), line)
		: text.replace("[profile.default]\n", `[profile.default]\n${line}\n`);
	writeFileSync(file, text);
}

const MEASURED_TEST = `${HEADER}import {Test} from "forge-std/Test.sol";

/// @title MeasuredTest
/// @notice A unit test with a cost worth recording.
contract MeasuredTest is Test {
    /// @notice Spends a little gas.
    function test_measured() public pure {
        uint256 total;
        for (uint256 index = 0; index < 10; index++) {
            total += index;
        }
        assertEq(total, 45);
    }
}
`;

const TWO_FUNCTIONS = `${HEADER}/// @title Two
/// @notice Two functions, one of which a test reaches.
contract Two {
    /// @notice The tested one.
    /// @return One.
    function reached() external pure returns (uint256) {
        return 1;
    }

    /// @notice The untested one.
    /// @param value A value.
    /// @return The value doubled.
    function unreached(uint256 value) external pure returns (uint256) {
        if (value > 10) {
            return value * 2;
        }
        return value + 2;
    }
}
`;

const TWO_FUNCTIONS_TEST = `${HEADER}import {Test} from "forge-std/Test.sol";
import {Two} from "../../src/Two.sol"; // scan-allow: relative to the fixture's own tree

/// @title TwoTest
/// @notice Reaches one of the two functions.
contract TwoTest is Test {
    /// @notice Calls the reached function.
    function test_reached() public {
        assertEq(new Two().reached(), 1);
    }
}
`;

/**
 * One planted violation per gate, each returning the tree to run in and what the red output must
 * name. The set of keys is one of three independent sources the reconciliation compares: a gate
 * with no entry here is a gate nobody has shown can fail.
 */
const redFixtures = {
	"clean-clone": () => {
		const dir = mkdtempSync(path.join(tmpdir(), "ci-clone-"));
		execFileSync("git", ["clone", "--quiet", root, dir]);
		// The working tree's tools, so the fixture exercises the script under test rather than
		// whatever happens to be committed.
		cpSync(path.join(root, "tools"), path.join(dir, "tools"), {
			recursive: true,
		});
		plant(
			dir,
			"contracts/test/unit/Broken.t.sol",
			`${HEADER}contract Broken {\n`,
		);
		const commit = (args) =>
			execFileSync(
				"git",
				[
					"-c",
					"user.name=fixture",
					"-c",
					"user.email=fixture@localhost",
					...args,
				],
				{ cwd: dir },
			);
		commit(["add", "-A"]);
		commit([
			"commit",
			"-q",
			"--no-verify",
			"-m",
			"fixture: an unbuildable tree",
		]);
		return { dir, names: /Broken/ };
	},
	"repository-suite": () => {
		const dir = scratch();
		plant(
			dir,
			"test/planted.test.js",
			'import assert from "node:assert/strict";\nimport { test } from "node:test";\n\ntest("planted", () => assert.fail("planted failure"));\n',
		);
		return { dir, names: /planted/ };
	},
	build: () => {
		const dir = scratch();
		plant(
			dir,
			"contracts/test/unit/Broken.t.sol",
			`${HEADER}contract Broken {\n`,
		);
		return { dir, names: /Broken/ };
	},
	format: () => {
		const dir = scratch();
		plant(
			dir,
			"contracts/test/unit/Ugly.t.sol",
			`${HEADER}contract Ugly {uint256 public   value;}\n`,
		);
		return { dir, names: /Ugly/ };
	},
	lint: () => {
		const dir = scratch();
		plant(
			dir,
			"contracts/src/Origin.sol",
			`${HEADER}/// @title Origin\n/// @notice Authorises by origin.\ncontract Origin {\n    /// @notice The owner.\n    address public owner;\n\n    /// @notice Whether the origin is the owner.\n    /// @return Whether it is.\n    function act() external view returns (bool) {\n        return tx.origin == owner;\n    }\n}\n`,
		);
		return { dir, names: /Origin/ };
	},
	documentation: () => {
		const dir = scratch();
		plant(
			dir,
			"contracts/test/unit/Undocumented.t.sol",
			`${HEADER}contract Undocumented {\n    function store(uint256 value) external pure returns (uint256) {\n        return value;\n    }\n}\n`,
		);
		return { dir, names: /Undocumented/ };
	},
	licences: () => {
		const dir = scratch();
		cpSync(
			path.join(root, "test", "licence-headers.test.js"),
			path.join(dir, "test", "licence-headers.test.js"),
		);
		plant(
			dir,
			"contracts/test/unit/Unlicensed.t.sol",
			"// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\n\ncontract Unlicensed {}\n",
		);
		return { dir, names: /Unlicensed/ };
	},
	selections: () => {
		const dir = scratch();
		plant(
			dir,
			"contracts/test/unit/Failing.t.sol",
			`${HEADER}import {Test} from "forge-std/Test.sol";\n\ncontract FailingTest is Test {\n    function test_fails() public pure {\n        assertTrue(false);\n    }\n}\n`,
		);
		return { dir, names: /test_fails/ };
	},
	size: () => {
		const dir = scratch();
		setKey(dir, "code_size_limit", "100");
		plant(
			dir,
			"contracts/src/Sized.sol",
			`${HEADER}contract Sized {\n    uint256[] public values;\n\n    function add(uint256 value) external {\n        values.push(value);\n    }\n}\n`,
		);
		return { dir, names: /Sized/ };
	},
	gas: () => {
		const dir = scratch();
		plant(dir, "contracts/test/unit/Measured.t.sol", MEASURED_TEST);
		execFileSync("forge", ["snapshot", "--match-path", UNIT_GLOB], {
			cwd: path.join(dir, "contracts"),
			stdio: "pipe",
		});
		const baseline = path.join(dir, "contracts", ".gas-snapshot");
		writeFileSync(
			baseline,
			readFileSync(baseline, "utf8").replace(/gas: \d+/, "gas: 1"),
		);
		return { dir, names: /test_measured/ };
	},
	coverage: () => {
		const dir = scratch();
		plant(dir, "contracts/src/Two.sol", TWO_FUNCTIONS);
		plant(dir, "contracts/test/unit/Two.t.sol", TWO_FUNCTIONS_TEST);
		plant(dir, "contracts/coverage-floor.txt", "100\n");
		return { dir, names: /floor/ };
	},
};

// --- The reconciliation -------------------------------------------------------------------

/** Every job in the workflow, as the text of its block. Indentation is the workflow's syntax. */
function jobs() {
	const text = read(workflowPath);
	const start = text.indexOf("\njobs:\n");
	if (start < 0) return {};
	const blocks = {};
	let current = null;
	for (const line of text.slice(start + 7).split("\n")) {
		const header = line.match(/^ {2}([a-z][a-z-]*):\s*$/);
		if (header) {
			current = header[1];
			blocks[current] = "";
		} else if (current) {
			blocks[current] += `${line}\n`;
		}
	}
	return blocks;
}

function runLines(block) {
	return [...block.matchAll(/^\s+run:\s*(.+)$/gm)].map((m) => m[1].trim());
}

test("the gate script, the workflow and the red fixtures name the same gates", () => {
	const gates = declared("GATES").sort();
	assert.ok(gates.length > 0, "the gate script declares no gates");
	assert.deepEqual(
		Object.keys(redFixtures).sort(),
		gates,
		"a gate with no fixture proving it can fail, or a fixture for a gate that does not exist",
	);
	const commands = new Set(declared("COMMANDS"));
	const stepped = runLines(jobs().gates ?? "")
		.map((line) => line.match(/^tools\/ci\.sh ([a-z-]+)$/)?.[1])
		.filter((name) => name && !commands.has(name))
		.sort();
	assert.deepEqual(
		stepped,
		gates,
		"the workflow's steps are not the script's gates",
	);
});

test("every step that runs anything is a script, except the one dependency install", () => {
	const lines = Object.values(jobs()).flatMap(runLines);
	assert.ok(lines.length > 0, "the workflow runs nothing");
	const notScripts = lines.filter((line) => !line.startsWith("tools/"));
	assert.deepEqual(notScripts, ["pnpm install --frozen-lockfile"]);
});

test("the toolchain the workflow installs is the one the repository pins", () => {
	const pinned = read(path.join(root, ".foundry-version")).trim();
	const installed = [
		...read(workflowPath).matchAll(
			/foundry-rs\/foundry-toolchain@v1\s*\n\s*with:\s*\n\s*version:\s*v?([0-9.]+)/g,
		),
	].map((m) => m[1]);
	assert.ok(installed.length > 0, "the workflow installs no pinned toolchain");
	for (const version of installed) assert.equal(version, pinned);
});

// --- Each gate on the real tree, and on a planted violation --------------------------------

for (const name of Object.keys(redFixtures)) {
	if (name === "repository-suite") continue;
	test(`the ${name} gate passes on the real tree and says how much it inspected`, () => {
		const { code, output } = gate(name);
		assert.equal(code, 0, output);
		const lines = [...output.matchAll(new RegExp(`^${name}: (.*)$`, "gm"))].map(
			(m) => m[1],
		);
		// Each count names whether the tool or this script produced it, because several tools
		// print nothing on success and a count of files found is not evidence of files read.
		const counts = lines
			.map((line) =>
				line.match(/^(\d+) .+ inspected \(counted by the (tool|script)\)$/),
			)
			.filter(Boolean);
		const unarmed = lines.filter((line) => /^unarmed: .{10,}$/.test(line));
		assert.ok(
			counts.length + unarmed.length > 0,
			`the ${name} gate neither counted anything nor said why it is unarmed:\n${output}`,
		);
		for (const count of counts) {
			assert.ok(
				Number(count[1]) > 0,
				`the ${name} gate inspected nothing: ${count[0]}`,
			);
		}
	});
}

for (const [name, fixture] of Object.entries(redFixtures)) {
	test(`the ${name} gate goes red on a planted violation and names it`, () => {
		const { dir, names } = fixture();
		try {
			const { code, output } = gate(name, dir);
			assert.notEqual(
				code,
				0,
				`the ${name} gate passed a planted violation:\n${output}`,
			);
			assert.match(output, names, output);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

// --- The size gate --------------------------------------------------------------------------

test("the size gate refuses a contract whose creation code alone is over the ceiling", () => {
	const dir = scratch();
	try {
		setKey(dir, "code_size_limit", "200");
		// A small runtime and a large constructor: only the creation code is over, at twice the
		// runtime ceiling.
		plant(
			dir,
			"contracts/src/Heavy.sol",
			`${HEADER}contract Heavy {\n    event Built(bytes32 digest);\n\n    constructor() {\n        bytes memory payload = hex"${"ab".repeat(600)}";\n        emit Built(keccak256(payload));\n    }\n}\n`,
		);
		const { code, output } = gate("size", dir);
		assert.notEqual(code, 0, output);
		assert.match(output, /Heavy/, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- The gas gate ---------------------------------------------------------------------------

test("the gas gate refuses to compare under a different pair of execution settings", () => {
	// Measured: the four combinations of the two settings swing by about fifty thousand gas, so a
	// comparison across a changed pair is noise, and noise gets the tolerance widened.
	const { dir } = redFixtures.gas();
	try {
		setKey(dir, "isolate", "false");
		const { code, output } = gate("gas", dir);
		assert.notEqual(code, 0, output);
		assert.match(output, /isolate/, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- The coverage gate ----------------------------------------------------------------------

test("the coverage gate passes the same tree against a floor it meets", () => {
	const { dir } = redFixtures.coverage();
	try {
		plant(dir, "contracts/coverage-floor.txt", "10\n");
		const { code, output } = gate("coverage", dir);
		assert.equal(code, 0, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the coverage gate treats a report that measured nothing as its own failure", () => {
	// Measured: on a tree with no source, the report is a zero-byte file with exit zero, and a
	// naive floor script reads that as a pass forever.
	const dir = scratch();
	try {
		plant(dir, "contracts/test/unit/Measured.t.sol", MEASURED_TEST);
		plant(dir, "contracts/coverage-floor.txt", "50\n");
		const { code, output } = gate("coverage", dir);
		assert.notEqual(code, 0, output);
		assert.match(output, /no source measured/, output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- The declared list, and the three tripwires ---------------------------------------------

test("the list of contracts out of the analyser's reach names only files that exist, and has not grown", () => {
	const listed = declared("NOT_PROTOCOL");
	for (const file of listed) {
		assert.ok(
			existsSync(path.join(root, file)),
			`${file} is listed and does not exist`,
		);
		assert.ok(
			NOT_PROTOCOL_CEILING.includes(file),
			`${file} was added to the list; it may only shrink`,
		);
	}
});

test("tripwire: every first-party contract is where the analyser can see it, or declared out of its reach", (t) => {
	// The analyser inspects contracts/src only, measured, and cannot be told otherwise — passing
	// a file's own path elsewhere still yields nothing. A contract anywhere else is invisible to it
	// unless someone decided so here.
	const unreachable = subjects().filter(
		(file) => !file.startsWith("contracts/src/"),
	);
	assert.deepEqual(unreachable, []);
	t.diagnostic(
		`${subjects().length} contracts in reach, ${declared("NOT_PROTOCOL").length} declared out of it`,
	);
});

test("tripwire: every first-party contract outside the declared list has a coverage floor it meets", (t) => {
	if (subjects().length === 0) {
		t.diagnostic(
			"unarmed: no first-party contract exists outside the declared list",
		);
		return;
	}
	assert.ok(
		existsSync(path.join(contracts, "coverage-floor.txt")),
		"first-party contracts exist and no coverage floor is committed",
	);
	const { code, output } = gate("coverage");
	assert.equal(code, 0, output);
	assert.doesNotMatch(output, /unarmed/, output);
});

test("tripwire: every first-party contract outside the declared list is exercised by a unit test, and every unit test has a gas baseline entry", (t) => {
	if (subjects().length === 0) {
		t.diagnostic(
			"unarmed: no first-party contract exists outside the declared list",
		);
		return;
	}
	// Exercised by the unit selection, measured by what the unit selection actually executes.
	const report = path.join(
		mkdtempSync(path.join(tmpdir(), "unit-coverage-")),
		"lcov.info",
	);
	execFileSync(
		"forge",
		[
			"coverage",
			"--match-path",
			UNIT_GLOB,
			"--report",
			"lcov",
			"--report-file",
			report,
		],
		{ cwd: contracts, stdio: "pipe" },
	);
	const hit = new Map();
	let current = null;
	for (const line of readFileSync(report, "utf8").split("\n")) {
		if (line.startsWith("SF:")) current = `contracts/${line.slice(3)}`;
		if (line.startsWith("LH:")) hit.set(current, Number(line.slice(3)));
	}
	for (const file of subjects()) {
		assert.ok((hit.get(file) ?? 0) > 0, `${file} is exercised by no unit test`);
	}

	// Matched on the name and an opening parenthesis: the listing gives bare names while the
	// baseline carries full signatures. Two overloads of one test name cannot be told apart here.
	const baseline = read(path.join(contracts, ".gas-snapshot"));
	assert.ok(
		baseline,
		"first-party contracts exist and no gas baseline is committed",
	);
	const listing = JSON.parse(
		execFileSync(
			"forge",
			["test", "--list", "--json", "--match-path", UNIT_GLOB],
			{
				cwd: contracts,
				encoding: "utf8",
			},
		),
	);
	for (const suites of Object.values(listing)) {
		for (const [suite, names] of Object.entries(suites)) {
			for (const name of names) {
				assert.ok(
					baseline.includes(`${suite}:${name}(`),
					`${suite}:${name} has no gas baseline entry`,
				);
			}
		}
	}
});

test("the tripwires are reported by name before any gate runs", () => {
	const { output } = gate("tripwires");
	for (const tripwire of [
		"where the analyser can see it",
		"has a coverage floor it meets",
		"has a gas baseline entry",
	]) {
		assert.match(output, new RegExp(tripwire), output);
	}
});

// --- The pipeline's secret tier, read from the workflow -------------------------------------

test("exactly one job holds a secret, and it is the forbidden-terms job", () => {
	// A job cannot enumerate the repository's secrets from inside, so "carries no secret" is only
	// assertable over the workflow file. Any in-job check is a denylist of names someone already knew.
	const blocks = jobs();
	assert.deepEqual(Object.keys(blocks).sort(), [
		"forbidden-terms",
		"fork",
		"gates",
	]);
	const holding = Object.entries(blocks)
		.filter(([, block]) => /\$\{\{\s*secrets\./.test(block))
		.map(([name]) => name);
	assert.deepEqual(holding, ["forbidden-terms"]);
});

test("the forbidden-terms job scans tracked files and the pushed message range, with full history", () => {
	const block = jobs()["forbidden-terms"] ?? "";
	assert.ok(runLines(block).includes("tools/ci.sh forbidden-terms"), block);
	assert.match(
		block,
		/fetch-depth:\s*0/,
		"a shallow checkout cannot produce the message range",
	);
	assert.match(block, /SCAN_BASE:/, block);
	assert.match(block, /SCAN_HEAD:/, block);
});

test("the workflow publishes nothing, hands no secret to untrusted code, and never cancels a run", () => {
	const text = read(workflowPath);
	assert.doesNotMatch(
		text,
		/upload-artifact/,
		"the workflow publishes an artefact",
	);
	assert.doesNotMatch(
		text,
		/pull_request_target/,
		"the untrusted-code trigger is present",
	);
	assert.match(
		text,
		/cancel-in-progress:\s*false/,
		"concurrency cancels runs in flight",
	);
	assert.doesNotMatch(
		text,
		/^\s+network:/m,
		"the toolchain's deprecated network input is passed",
	);
	for (const [name, block] of Object.entries(jobs())) {
		assert.match(block, /timeout-minutes:\s*\d+/, `${name} has no timeout`);
		assert.match(
			block,
			/runs-on:\s*ubuntu-24\.04-arm\s*$/m,
			`${name} floats its runner`,
		);
	}
});

test("the forbidden-terms command refuses to pass when it has no salt", () => {
	// A pull request from a fork receives no secret. Not evaluated is its own non-green state:
	// absence of the salt must not satisfy the one gate whose failure cannot be undone.
	const { code, output } = gate("forbidden-terms", root, {
		SCAN_SALT: "",
		SCAN_BASE: "",
		SCAN_HEAD: "HEAD",
	});
	assert.notEqual(code, 0, output);
	assert.match(output, /not evaluated/, output);
});

test("the forbidden-terms command reports a hit in a commit message by identifier only", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ci-messages-"));
	try {
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
		cpSync(path.join(root, "tools"), path.join(dir, "tools"), {
			recursive: true,
		});
		writeFileSync(path.join(dir, "tools", "forbidden.sha256"), `${digest}\n`);
		const git = (args) =>
			execFileSync(
				"git",
				[
					"-c",
					"user.name=fixture",
					"-c",
					"user.email=fixture@localhost",
					...args,
				],
				{ cwd: dir, encoding: "utf8" },
			).trim();
		git(["init", "-q"]);
		git(["add", "-A"]);
		git(["commit", "-q", "--no-verify", "-m", "a clean first message"]);
		const base = git(["rev-parse", "HEAD"]);
		git([
			"commit",
			"-q",
			"--no-verify",
			"--allow-empty",
			"-m",
			`a message holding ${term}`,
		]);
		const head = git(["rev-parse", "HEAD"]);

		const { code, output } = gate("forbidden-terms", dir, {
			SCAN_SALT: salt,
			SCAN_BASE: base,
			SCAN_HEAD: head,
		});
		assert.notEqual(code, 0, output);
		assert.match(output, new RegExp(`^${head} forbidden token$`, "m"), output);
		assert.doesNotMatch(
			output,
			new RegExp(term),
			"the matched term was printed",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
