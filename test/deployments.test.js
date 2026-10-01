import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Which endpoint reads which chain. No key, no funds, no writes, unbounded re-runs.
const readTier = {
	10143: "MONAD_TESTNET_RPC_URL",
	143: "MONAD_ARCHIVE_RPC_URL",
};

// Where to read when nothing is configured. Without this a stranger who clones this
// repository gets a red test and no way to guess the variable it wanted, which would
// make the claim that anyone can check this record without asking anyone for anything
// false. Public, keyless, and overridden by the variables above.
const fallback = {
	10143: "https://testnet-rpc.monad.xyz",
	143: "https://rpc-mainnet.monadinfra.com",
};

function git(args, cwd = root) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Every record this repository has committed. The local chain's file is never one. */
function committedBooks() {
	const listed = git(["ls-files", "contracts/deployments"]);
	return listed ? listed.split("\n") : [];
}

/** The creation bytecode this repository builds at a commit, built from that commit. */
function creationCodeAt(commit, key) {
	const dir = mkdtempSync(path.join(tmpdir(), "atcommit-"));
	try {
		execFileSync(
			"git",
			["clone", "--quiet", "--recurse-submodules", root, dir],
			{
				encoding: "utf8",
			},
		);
		execFileSync("git", ["checkout", "--quiet", commit], { cwd: dir });
		execFileSync(
			"git",
			["submodule", "update", "--init", "--recursive", "--quiet"],
			{
				cwd: dir,
			},
		);
		execFileSync("forge", ["build", "--root", path.join(dir, "contracts")], {
			encoding: "utf8",
		});
		const artefact = JSON.parse(
			readFileSync(
				path.join(dir, "contracts", "out", "DeployProbe.s.sol", `${key}.json`),
				"utf8",
			),
		);
		return artefact.bytecode.object;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("every committed record matches the chain, read with no key and no funds", () => {
	const books = committedBooks();
	// An empty set that reports success is a gate that cannot fail.
	assert.ok(
		books.length > 0,
		"no record is committed yet, so this test has checked nothing",
	);
	// Across every record, not one: a record holding only third-party addresses contributes
	// nothing here, and this must not become a way for the whole check to go quiet.
	let checked = 0;

	for (const book of books) {
		const chainId = path.basename(book, ".json");
		const variable = readTier[chainId];
		assert.ok(variable, `no read endpoint is declared for chain ${chainId}`);
		const url = process.env[variable] ?? fallback[chainId];
		assert.ok(url, `no endpoint is known for chain ${chainId}`);
		// An override pointing elsewhere would have every comparison below made against
		// a different chain, and the failure would read as a record mismatch.
		assert.equal(
			execFileSync("cast", ["chain-id", "--rpc-url", url], {
				encoding: "utf8",
			}).trim(),
			chainId,
			`${variable} points at a different chain than the record names`,
		);

		const entries = JSON.parse(readFileSync(path.join(root, book), "utf8"));
		// Narrowed to what this repository deployed. A record may also carry third-party
		// addresses, which have no creation transaction of ours to compare against — and the
		// single-writer rule survives that, because the two have two different writers: the
		// wrapper writes this section from a receipt, a person writes the other, and nothing
		// writes both.
		const generated = Object.entries(entries).filter(
			([, entry]) =>
				entry !== null && typeof entry === "object" && "txHash" in entry,
		);
		checked += generated.length;
		for (const [key, entry] of generated) {
			// The creation input, not the runtime code: a contract with an immutable differs
			// from its artefact by exactly the bytes the constructor wrote.
			const sent = execFileSync(
				"cast",
				["tx", entry.txHash, "input", "--rpc-url", url],
				{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
			).trim();

			const salt = entry.salt.replace(/^0x/, "");
			const code = creationCodeAt(entry.commit, key).replace(/^0x/, "");
			const args = entry.constructorArgs.replace(/^0x/, "");
			assert.equal(
				sent.toLowerCase(),
				`0x${salt}${code}${args}`.toLowerCase(),
				`${book} ${key}: the chain and the recorded commit disagree`,
			);
		}
	}
	assert.ok(checked > 0, "no deployment of ours was checked against any chain");
});
