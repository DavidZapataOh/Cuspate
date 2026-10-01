import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contracts = path.join(root, "contracts");
const big = 256 * 1024 * 1024;

// The directory is the selection and the only thing that is: a filename suffix can drift from
// the directory it sits in. The unit selection names the one file inherited at the test root,
// so a second file there is a failure rather than a silent gap.
const INHERITED_AT_ROOT = "test/Toolchain.t.sol";
const selections = {
	unit: `test/{unit/*,${path.basename(INHERITED_AT_ROOT)}}`,
	fuzz: "test/fuzz/*",
	invariant: "test/invariant/*",
	fork: "test/fork/*",
};

// The fork selection is never executed here. A fork cannot be created without egress even with
// a warm cache, because the backend asks the endpoint for its chain id before consulting the
// cache — and this file is run by the clean-clone gate under an emptied environment.
const EXECUTED_HERE = ["unit", "fuzz", "invariant"];

// Floors, not settings. A later plan may raise these and may not lower them.
const INVARIANT_RUNS_FLOOR = 128;
const INVARIANT_DEPTH_FLOOR = 256;

function forge(args) {
	return JSON.parse(
		execFileSync("forge", args, {
			cwd: contracts,
			encoding: "utf8",
			maxBuffer: big,
		}),
	);
}

/** Every test function the runner can see, from the listing, which executes nothing. */
function listed(glob) {
	const args = ["test", "--list", "--json"];
	if (glob) args.push("--match-path", glob);
	const found = [];
	for (const [file, suites] of Object.entries(forge(args))) {
		for (const [suite, names] of Object.entries(suites)) {
			for (const name of names) found.push({ file, suite, name });
		}
	}
	return found;
}

/**
 * Every result the runner produced, with the kind it assigned.
 *
 * One reported result is not one test function: every invariant function in a contract
 * collapses into a single reported result, and measured, the machine-readable output carries
 * no list of the collapsed names. So invariant agreement is checked per contract and the
 * function names come from the listing.
 */
// One run per selection. Without this each assertion re-runs the campaign, which is most of a
// hundred seconds of the same measurement taken eight times.
const runs = new Map();

function executed(glob) {
	const remembered = runs.get(glob);
	if (remembered) return remembered;
	const found = measure(glob);
	runs.set(glob, found);
	return found;
}

function measure(glob) {
	let output;
	try {
		output = forge(["test", "--json", "--match-path", glob]);
	} catch (error) {
		// A failing run still prints its report, so it is read from the failure. A selection the
		// runner collected nothing for prints no report at all, which the emptiness and
		// agreement assertions report rather than this hiding it.
		try {
			output = JSON.parse(error.stdout);
		} catch {
			output = {};
		}
	}
	const found = [];
	for (const [key, body] of Object.entries(output)) {
		const [file, suite] = key.split(":");
		for (const [signature, result] of Object.entries(body.test_results)) {
			found.push({
				file,
				suite,
				name: signature.replace(/\(.*$/, ""),
				kind: Object.keys(result.kind)[0],
				detail: Object.values(result.kind)[0],
				status: result.status,
			});
		}
	}
	return found;
}

function solidityUnder(directory) {
	const full = path.join(contracts, directory);
	if (!existsSync(full)) return [];
	const found = [];
	for (const entry of readdirSync(full)) {
		const next = path.join(full, entry);
		if (statSync(next).isDirectory()) {
			found.push(...solidityUnder(path.join(directory, entry)));
		} else if (entry.endsWith(".sol")) {
			found.push(path.join(directory, entry));
		}
	}
	return found;
}

function configuration() {
	return readFileSync(path.join(contracts, "foundry.toml"), "utf8");
}

/** The body of every section whose header ends in the given name. */
function sections(name) {
	const found = [];
	const pattern = new RegExp(`^\\[(?:[\\w.]+\\.)?${name}\\]([^[]*)`, "gm");
	for (const match of configuration().matchAll(pattern)) found.push(match[1]);
	return found;
}

function stated(body, key) {
	const match = body.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, "m"));
	return match ? Number(match[1]) : null;
}

test("every local selection executes everything it lists", () => {
	// Measured, and this is the meter that caught it: the runner's incremental build cache can
	// drop a test contract from the run while the listing still sees it, and the run then
	// reports fewer tests and exits zero. With no path filter at all, three of four functions
	// ran and the command succeeded. Comparing the two is the only way to see that.
	for (const name of ["unit", "fuzz"]) {
		assert.deepEqual(
			executed(selections[name])
				.map((t) => `${t.file}:${t.name}`)
				.sort(),
			listed(selections[name])
				.map((t) => `${t.file}:${t.name}`)
				.sort(),
			`the ${name} selection did not execute everything it lists`,
		);
	}
	// Per contract, because the results collapse a contract's invariant functions into one.
	assert.deepEqual(
		[
			...new Set(
				executed(selections.invariant).map((t) => `${t.file}:${t.suite}`),
			),
		].sort(),
		[
			...new Set(
				listed(selections.invariant).map((t) => `${t.file}:${t.suite}`),
			),
		].sort(),
		"the invariant selection did not execute every campaign it lists",
	);
});

test("the runner reports exactly the three kinds this harness knows about", () => {
	// A fourth kind would make the classification below stop being a partition, and would make
	// the fork selection's membership of unit-or-fuzz stop being an argument.
	for (const name of EXECUTED_HERE) {
		for (const executedTest of executed(selections[name])) {
			assert.ok(
				["Unit", "Fuzz", "Invariant"].includes(executedTest.kind),
				`the runner reported an unknown kind: ${executedTest.kind}`,
			);
		}
	}
});

test("no selection matched zero tests", () => {
	// The anti-gaming clause. Four selections running from one command is satisfied by four
	// empty ones, and the likelier real failure is a path filter that stops matching after a
	// directory is reorganised.
	for (const [name, glob] of Object.entries(selections)) {
		assert.ok(
			listed(glob).length > 0,
			`the ${name} selection matched no test function`,
		);
	}
});

test("the kinds the runner reports partition every test function", () => {
	const executedFunctions = ["unit", "fuzz"].flatMap((name) =>
		executed(selections[name]).map((t) => `${t.file}:${t.name}`),
	);
	// Invariant and fork functions are enumerated from the listing: the first because the
	// results collapse them, the second because reading its kind would need egress.
	const enumerated = ["invariant", "fork"].flatMap((name) =>
		listed(selections[name]).map((t) => `${t.file}:${t.name}`),
	);
	const covered = [...executedFunctions, ...enumerated];
	assert.deepEqual(
		[...new Set(covered)].sort(),
		listed(null)
			.map((t) => `${t.file}:${t.name}`)
			.sort(),
		"the selections do not cover exactly the tests the runner can see",
	);
	assert.equal(
		covered.length,
		new Set(covered).size,
		"a test function is claimed by more than one selection",
	);
});

test("every test in a kind-named selection reports that kind", () => {
	// Deliberately not applied to fork/: forking is not a kind, so a fork test reports unit or
	// fuzz and asserting directory-equals-kind there would fail by construction.
	const expected = { unit: "Unit", fuzz: "Fuzz", invariant: "Invariant" };
	for (const name of EXECUTED_HERE) {
		for (const executedTest of executed(selections[name])) {
			assert.equal(
				executedTest.kind,
				expected[name],
				`${executedTest.file}:${executedTest.name} reports ${executedTest.kind}`,
			);
		}
	}
});

test("every file in the fork selection selects a fork in its setup", () => {
	// This is the fork directory's real defining property, and it is readable from the source
	// without egress.
	const files = solidityUnder("test/fork");
	assert.ok(files.length > 0, "the fork selection holds no file");
	for (const file of files) {
		assert.match(
			readFileSync(path.join(contracts, file), "utf8"),
			/vm\.createSelectFork\(|vm\.selectFork\(/,
			`${file} is in the fork selection and selects no fork`,
		);
	}
});

test("no test anywhere is disabled", () => {
	// Four mechanisms, because only the first reports a skipped test; the other three report a
	// green pass, so reading the output tells you nothing. Matched as call forms: a bare word
	// search both misses two of them and fires on the library's time-advancing helper, which
	// shares its name with the cheatcode.
	const mechanisms = [
		[/\bvm\.skip\s*\(/, "the skip cheatcode"],
		[/\bskipWhenForking\b/, "the skip-when-forking modifier"],
		[/\bskipWhenNotForking\b/, "the skip-when-not-forking modifier"],
		[/\btry\s+vm\.env/, "a try around an environment read"],
		[
			/if\s*\([^)]*(?:chainid|activeFork|isFork)[^)]*\)\s*\{?\s*return\b/,
			"an early return guarded by a fork check",
		],
	];
	// Over every test directory and the helpers: a guard inherited from a helper disables tests
	// in a directory the search never looked at.
	const offending = [];
	for (const file of solidityUnder("test")) {
		const source = readFileSync(path.join(contracts, file), "utf8");
		for (const [pattern, description] of mechanisms) {
			if (pattern.test(source)) offending.push(`${file}: ${description}`);
		}
	}
	assert.deepEqual(offending, []);
});

test("every test file lives in exactly one selection", () => {
	const directories = ["unit", "fuzz", "invariant", "fork", "helpers"];
	assert.deepEqual(
		solidityUnder("test").filter(
			(file) => !directories.includes(file.split("/")[1]),
		),
		[INHERITED_AT_ROOT],
		"the test root holds something other than the one inherited file",
	);
});

test("the one command reports a name and a count for a selection", () => {
	for (const name of EXECUTED_HERE) {
		const output = execFileSync("./tools/test.sh", [name], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: big,
		});
		assert.match(
			output,
			new RegExp(`^${name} [1-9][0-9]*$`, "m"),
			`the command reported no count for ${name}:\n${output}`,
		);
	}
});

test("the fuzz run count the runner reports is the number the configuration file states", () => {
	// Read from the file's text, not from the resolved configuration: both sides of that
	// comparison come from the same resolved value, so it is a tautology that passes while the
	// section is misspelled — and a misspelled profile name produces no unknown-key warning
	// either. The regression this meter is named for is a section that does not apply, and only
	// the file text knows what was intended.
	const [body] = sections("fuzz");
	assert.ok(body, "the configuration file declares no fuzz section");
	const runs = stated(body, "runs");
	assert.ok(runs > 0, "the fuzz section states no run count");

	const tests = executed(selections.fuzz);
	assert.ok(tests.length > 0, "the fuzz selection executed nothing");
	for (const fuzzTest of tests) {
		assert.equal(
			fuzzTest.detail.runs,
			runs,
			`${fuzzTest.name} ran ${fuzzTest.detail.runs} times and the file states ${runs}`,
		);
	}
});

test("the invariant campaign made the calls its configuration asks for", () => {
	const [body] = sections("invariant");
	assert.ok(body, "the configuration file declares no invariant section");
	const runs = stated(body, "runs");
	const depth = stated(body, "depth");
	assert.ok(
		runs > 0 && depth > 0,
		"the invariant section states no runs or no depth",
	);

	const campaigns = executed(selections.invariant);
	assert.ok(campaigns.length > 0, "the invariant selection executed nothing");
	for (const campaign of campaigns) {
		assert.ok(campaign.detail.calls > 0, `${campaign.suite} made no calls`);
		// Ninety per cent, so a campaign cannot satisfy this by making three calls.
		assert.ok(
			campaign.detail.calls >= 0.9 * runs * depth,
			`${campaign.suite} made ${campaign.detail.calls} calls against ${runs} x ${depth}`,
		);
	}
});

test("the invariant campaign reverted on nothing", () => {
	// Zero, not a ceiling. With refusal-on-revert on a campaign aborts at its first revert, so
	// a passing run can only ever show zero and any non-zero rate has already failed the run.
	// Stating a rate under a ceiling as well would be the same assertion twice.
	for (const campaign of executed(selections.invariant)) {
		assert.equal(
			campaign.detail.reverts,
			0,
			`${campaign.suite} reverted ${campaign.detail.reverts} times`,
		);
	}
});

test("every invariant section refuses a campaign that reverts", () => {
	// Every section, not merely the default one: otherwise a later plan writes a deeper profile
	// with this off and makes its claims there, unmetered, which would void the whole point.
	const bodies = sections("invariant");
	assert.ok(
		bodies.length > 0,
		"the configuration file declares no invariant section",
	);
	for (const body of bodies) {
		assert.match(
			body,
			/^fail_on_revert\s*=\s*true/m,
			"an invariant section does not refuse a campaign that reverts",
		);
	}
});

test("the configured campaign is at or above the floors recorded here", () => {
	for (const body of sections("invariant")) {
		assert.ok(
			stated(body, "runs") >= INVARIANT_RUNS_FLOOR,
			`an invariant section runs fewer than ${INVARIANT_RUNS_FLOOR} times`,
		);
		assert.ok(
			stated(body, "depth") >= INVARIANT_DEPTH_FLOOR,
			`an invariant section is shallower than ${INVARIANT_DEPTH_FLOOR}`,
		);
	}
});

test("every campaign closes by proving it changed the subject", () => {
	// The dual of a reverting campaign, and invisible to every assertion above: a handler whose
	// calls do nothing reverts never, makes every call, and establishes nothing.
	for (const file of solidityUnder("test/invariant")) {
		const source = readFileSync(path.join(contracts, file), "utf8");
		if (!/function\s+invariant_/.test(source)) continue;
		assert.match(
			source,
			/function\s+afterInvariant\s*\(/,
			`${file} runs a campaign and never checks that it changed anything`,
		);
	}
});

test("every invariant property asserts something", () => {
	// An empty-bodied property passes forever, and counting functions never notices.
	const offending = [];
	for (const file of solidityUnder("test/invariant")) {
		const source = readFileSync(path.join(contracts, file), "utf8");
		for (const match of source.matchAll(
			/function\s+(invariant_\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n {4}\}/g,
		)) {
			if (!/\bassert\w*\s*\(/.test(match[2])) {
				offending.push(`${file}: ${match[1]}`);
			}
		}
	}
	assert.deepEqual(offending, []);
});
