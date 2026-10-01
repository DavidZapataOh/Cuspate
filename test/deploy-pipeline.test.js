import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The deployer on a local node is one of the node's own unlocked accounts, so no
// key exists anywhere in this suite. The signer tier stays empty locally.
const UNLOCKED_SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

let nextPort = 8600 + (process.pid % 300) * 4;

function cast(args) {
	return execFileSync("cast", args, { encoding: "utf8", stdio: "pipe" }).trim();
}

async function reachable(url) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			cast(["chain-id", "--rpc-url", url]);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error(`no node answered at ${url}`);
}

/**
 * Runs the body against a freshly started local node with this network's semantics.
 *
 * The chain id is a parameter so the path a public chain takes can be rehearsed without
 * spending anything. A node answering with a public chain's id is still a local node, so
 * no test may let such a run reach the record this repository commits.
 */
async function withNode(body, chainId = 31337) {
	const port = nextPort;
	nextPort += 1;
	const url = `http://127.0.0.1:${port}`;
	const node = spawn(
		"anvil",
		[
			"--network",
			"monad",
			"--chain-id",
			String(chainId),
			"--port",
			String(port),
			"--silent",
		],
		{ stdio: "ignore" },
	);
	try {
		await reachable(url);
		return await body(url);
	} finally {
		node.kill("SIGKILL");
	}
}

function deploy(url, extra = {}, args = ["--broadcast"]) {
	// Both streams, on both paths: the wrapper reports to stderr, so reading stdout alone
	// would assert against an empty string on every successful run.
	const result = spawnSync("./tools/deploy.sh", args, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: {
			...process.env,
			LOCAL_RPC_URL: url,
			DEPLOY_NETWORK: "local",
			DEPLOY_SENDER: UNLOCKED_SENDER,
			DEPLOY_SIGNER: "unlocked",
			...extra,
		},
	});
	return {
		code: result.status ?? 1,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

function bookPath(chainId) {
	return path.join(root, "contracts", "deployments", `${chainId}.json`);
}

function forgetLocalBook() {
	rmSync(bookPath(31337), { force: true });
}

test("the address the book records holds the bytecode this repository builds", async () => {
	forgetLocalBook();
	await withNode(async (url) => {
		const { code, output } = deploy(url);
		assert.equal(code, 0, output);

		// One source: the generated file.
		assert.ok(existsSync(bookPath(31337)), `no book written:\n${output}`);
		const entry = JSON.parse(readFileSync(bookPath(31337), "utf8")).Probe;
		assert.ok(entry, `no Probe entry:\n${output}`);

		// An independent source: the chain itself.
		const onChain = cast(["code", entry.address, "--rpc-url", url]);
		const built = JSON.parse(
			readFileSync(
				path.join(root, "contracts", "out", "DeployProbe.s.sol", "Probe.json"),
				"utf8",
			),
		).deployedBytecode.object;
		assert.equal(onChain, built, "the recorded address does not hold our code");
	});
});

test("the entry records every field the pipeline promises and nothing else", async () => {
	const entry = JSON.parse(readFileSync(bookPath(31337), "utf8")).Probe;
	assert.deepEqual(Object.keys(entry).sort(), [
		"address",
		"block",
		"commit",
		"constructorArgs",
		"factory",
		"salt",
		"txHash",
	]);
	assert.equal(
		entry.factory.toLowerCase(),
		"0x4e59b44847b379578588920ca78fbf26c0b4956c",
	);
	assert.match(entry.txHash, /^0x[0-9a-f]{64}$/);
	assert.match(entry.commit, /^[0-9a-f]{40}$/);
	assert.ok(entry.block > 0, "the recorded block is not a real block");
});

test("the wrapper refuses an alias whose endpoint reports a different chain", async () => {
	await withNode(async (url) => {
		const { code, output } = deploy(
			url,
			{ DEPLOY_NETWORK: "monad_testnet", MONAD_TESTNET_RPC_URL: url },
			[],
		);
		assert.notEqual(
			code,
			0,
			`the wrapper accepted an endpoint that is not the chain the alias names:\n${output}`,
		);
		assert.match(output, /10143/, output);
		assert.match(output, /31337/, output);
	});
});

test("the chain the endpoint reports is the chain whose file is written", async () => {
	forgetLocalBook();
	await withNode(async (url) => {
		const { code, output } = deploy(url);
		assert.equal(code, 0, output);
		// Two independent sources for the same number: the endpoint, and the filename the
		// wrapper chose. Neither is read from configuration.
		const reported = cast(["chain-id", "--rpc-url", url]);
		assert.ok(
			existsSync(bookPath(reported)),
			`the endpoint reports ${reported} and no book was written for it:\n${output}`,
		);
	});
});

test("the same salt reaches the same address on two fresh chains", async () => {
	const seen = [];
	for (let round = 0; round < 2; round += 1) {
		forgetLocalBook();
		await withNode(async (url) => {
			const { code, output } = deploy(url);
			assert.equal(code, 0, output);
			seen.push(JSON.parse(readFileSync(bookPath(31337), "utf8")).Probe);
		});
	}
	for (const field of [
		"address",
		"factory",
		"salt",
		"constructorArgs",
		"commit",
	]) {
		assert.equal(
			seen[0][field],
			seen[1][field],
			`${field} disagrees across chains`,
		);
	}
});

test("a second run against the same chain refuses and names the address", async () => {
	forgetLocalBook();
	await withNode(async (url) => {
		const first = deploy(url);
		assert.equal(first.code, 0, first.output);
		const entry = JSON.parse(readFileSync(bookPath(31337), "utf8")).Probe;

		const second = deploy(url);
		assert.notEqual(
			second.code,
			0,
			`a duplicate deploy succeeded:\n${second.output}`,
		);
		assert.match(second.output, new RegExp(entry.address, "i"), second.output);
	});
});

test("a rehearsal does not block the real run that follows it", async () => {
	forgetLocalBook();
	await withNode(async (url) => {
		// A guard that read the record rather than the chain would be wedged here.
		const rehearsal = deploy(url, {}, []);
		assert.equal(rehearsal.code, 0, rehearsal.output);
		const real = deploy(url);
		assert.equal(
			real.code,
			0,
			`the rehearsal wedged the real run:\n${real.output}`,
		);
	});
});

test("an overridden salt moves the address", async () => {
	forgetLocalBook();
	await withNode(async (url) => {
		const one = deploy(url, { PROBE_SALT: `0x${"11".repeat(32)}` });
		assert.equal(one.code, 0, one.output);
		const first = JSON.parse(readFileSync(bookPath(31337), "utf8")).Probe
			.address;

		const two = deploy(url, { PROBE_SALT: `0x${"22".repeat(32)}` });
		assert.equal(two.code, 0, two.output);
		const second = JSON.parse(readFileSync(bookPath(31337), "utf8")).Probe
			.address;

		// A later plan must be able to search for an address whose low bits carry meaning.
		assert.notEqual(first, second, "the salt does not reach the address");
	});
});

test("the refusal an operator reads is the readable one, not a revert", async () => {
	forgetLocalBook();
	await withNode(async (url) => {
		assert.equal(deploy(url).code, 0);
		const { output } = deploy(url);
		// The factory reverts on a repeated salt underneath, so even a wrapper bug is
		// fail-closed; but an opaque revert is not what a person should have to read.
		assert.match(output, /refusing: code already exists/, output);
	});
});

test("the gas the creating transaction sent is within 1.5x the gas it used", async () => {
	forgetLocalBook();
	await withNode(async (url) => {
		const { code, output } = deploy(url);
		assert.equal(code, 0, output);
		const entry = JSON.parse(readFileSync(bookPath(31337), "utf8")).Probe;

		// Read from the transaction and the receipt, never from a field that claims the
		// limit was fixed: on this network that field reports success while the value it
		// reports on is replaced.
		const sent = Number(cast(["tx", entry.txHash, "gas", "--rpc-url", url]));
		const used = Number(
			cast(["receipt", entry.txHash, "gasUsed", "--rpc-url", url]),
		);
		assert.ok(sent > 0, `no gas limit on the transaction: ${sent}`);
		assert.ok(used > 0, `no gas used on the receipt: ${used}`);

		// The ceiling is 1.5 and not a round 2 because the default estimate multiplier is
		// 1.3, so 1.5 leaves room for an honest estimate and refuses a limit that was never
		// narrowed. Gas here is charged on the limit, so this number is the price.
		assert.ok(
			sent <= used * 1.5,
			`sent a limit of ${sent} for ${used} of gas used`,
		);
	});
});

test("the gas limit sent is the same on two fresh chains", async () => {
	const sent = [];
	for (let round = 0; round < 2; round += 1) {
		forgetLocalBook();
		await withNode(async (url) => {
			assert.equal(deploy(url).code, 0);
			const entry = JSON.parse(readFileSync(bookPath(31337), "utf8")).Probe;
			sent.push(cast(["tx", entry.txHash, "gas", "--rpc-url", url]));
		});
	}
	assert.equal(
		sent[0],
		sent[1],
		"the limit is not a function of the commit alone",
	);
});

test("an emptied environment is refused by name and by tier", () => {
	const { code, output } = (() => {
		try {
			return {
				code: 0,
				output: execFileSync("./tools/deploy.sh", [], {
					cwd: root,
					encoding: "utf8",
					stdio: "pipe",
					env: { PATH: process.env.PATH },
				}),
			};
		} catch (error) {
			return {
				code: error.status ?? 1,
				output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
			};
		}
	})();
	assert.notEqual(code, 0, "an emptied environment was accepted");
	assert.match(output, /missing DEPLOY_NETWORK \(read tier\)/, output);
});

test("the documented environment is exactly the environment three sources require", () => {
	const required = new Set();

	// One: what the wrapper requires in shell.
	const wrapper = readFileSync(path.join(root, "tools", "deploy.sh"), "utf8");
	for (const m of wrapper.matchAll(/^\s*require_var ([A-Z0-9_]+) /gm)) {
		required.add(m[1]);
	}

	// Two: the interpolations in the alias block. Scanning only the Solidity goes green
	// while the file is incomplete, which is why this source exists.
	const toml = readFileSync(
		path.join(root, "contracts", "foundry.toml"),
		"utf8",
	);
	const aliases = toml.slice(toml.indexOf("[rpc_endpoints]"));
	for (const m of aliases.matchAll(/\$\{([A-Z0-9_]+)\}/g)) required.add(m[1]);

	// Three: the environment call sites in the Solidity, excluding the ones with a
	// default, because requiring an optional site would invert this test.
	for (const file of ["AddressBook.sol", "DeployProbe.s.sol"]) {
		const source = readFileSync(
			path.join(root, "contracts", "script", file),
			"utf8",
		);
		for (const m of source.matchAll(
			/\bvm\.env(?!Or)[A-Za-z]*\("([A-Z0-9_]+)"\)/g,
		)) {
			required.add(m[1]);
		}
	}

	const example = readFileSync(path.join(root, ".env.example"), "utf8");
	const documented = new Set(
		[...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]),
	);

	assert.deepEqual([...documented].sort(), [...required].sort());
});

test("the example environment carries no value that could be a real secret", () => {
	const example = readFileSync(path.join(root, ".env.example"), "utf8");
	for (const line of example.split("\n")) {
		const assignment = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (!assignment) continue;
		assert.equal(
			assignment[2],
			"",
			`${assignment[1]} carries a value; a placeholder shaped like a key invites a real one`,
		);
	}
});

test("no tracked file carries a key-shaped value or a credentialled endpoint", () => {
	// Open-quantified over files that do not exist yet.
	const tracked = execFileSync("git", ["ls-files"], {
		cwd: root,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean);

	const keyShaped =
		/(?:private[_-]?key|secret[_-]?key|mnemonic)\s*[:=]\s*['"]?(?:0x)?[0-9a-fA-F]{32,}/;
	const credentialled = /https?:\/\/[^\s"'/]*:[^\s"'/]*@/;
	const pathKeyed = /https?:\/\/[^\s"']*\/v[23]\/[A-Za-z0-9_-]{20,}/;

	const offending = [];
	for (const file of tracked) {
		const full = path.join(root, file);
		if (!existsSync(full)) continue;
		let text;
		try {
			text = readFileSync(full, "utf8");
		} catch {
			continue;
		}
		for (const [number, line] of text.split("\n").entries()) {
			if (
				keyShaped.test(line) ||
				credentialled.test(line) ||
				pathKeyed.test(line)
			) {
				offending.push(`${file}:${number + 1}`);
			}
		}
	}
	assert.deepEqual(offending, []);
});

test("the build cache, where a broadcast leaves sensitive values, is ignored", () => {
	const { status } = (() => {
		try {
			execFileSync("git", ["check-ignore", "-q", "contracts/cache/anything"], {
				cwd: root,
			});
			return { status: 0 };
		} catch (error) {
			return { status: error.status ?? 1 };
		}
	})();
	assert.equal(status, 0, "the build cache is not ignored");
});

test("the wrapper produces and scans the verification input on a rehearsal too", async () => {
	forgetLocalBook();
	await withNode(async (url) => {
		rmSync(path.join(root, "contracts", "cache", "verification"), {
			recursive: true,
			force: true,
		});
		const { code, output } = deploy(url, {}, []);
		assert.equal(code, 0, output);
		const input = path.join(
			root,
			"contracts",
			"cache",
			"verification",
			"Probe.json",
		);
		assert.ok(existsSync(input), `the rehearsal produced no input:\n${output}`);
		assert.match(output, /scan ran partially|forbidden token/, output);
		// Measured: a subject declared inside a script carries every source it imports.
		const sources = Object.keys(
			JSON.parse(readFileSync(input, "utf8")).sources,
		);
		assert.ok(sources.length > 1, `only ${sources.length} source published`);
	});
});

test("a broadcast to a public chain without the scanner's salt is refused", async () => {
	await withNode(async (url) => {
		const { code, output } = deploy(url, {
			DEPLOY_NETWORK: "monad_testnet",
			MONAD_TESTNET_RPC_URL: url,
			SCAN_SALT: "",
		});
		assert.notEqual(code, 0, `a keyless publish was accepted:\n${output}`);
		assert.match(output, /missing SCAN_SALT \(publish tier\)/, output);
		// Nothing may have been written for the chain whose record is committed.
		assert.ok(
			!existsSync(bookPath(10143)),
			"a local run wrote the committed record",
		);
	}, 10143);
});
