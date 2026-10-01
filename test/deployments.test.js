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

	for (const book of books) {
		const chainId = path.basename(book, ".json");
		const variable = readTier[chainId];
		assert.ok(variable, `no read endpoint is declared for chain ${chainId}`);
		const url = process.env[variable];
		assert.ok(url, `${variable} is unset, so this record cannot be checked`);

		const entries = JSON.parse(readFileSync(path.join(root, book), "utf8"));
		for (const [key, entry] of Object.entries(entries)) {
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
});
