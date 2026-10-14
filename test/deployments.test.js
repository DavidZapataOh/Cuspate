import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
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

/**
 * Where an entry's creation code is built: the source and contract it records, or for an entry
 * recorded before entries named their source, the probe script's contract of the entry's own name.
 */
export function artefactOf(key, entry) {
	const [file, name] = (
		entry.contract ?? `script/DeployProbe.s.sol:${key}`
	).split(":");
	return path.join("contracts", "out", path.basename(file), `${name}.json`);
}

/**
 * A checkout of a commit with its contracts built, one per commit for the whole run: every entry
 * of a deployment usually records the same commit, and building once per entry multiplies the
 * slowest step of this file by the number of contracts deployed.
 */
const builtAt = new Map();
function buildAt(commit) {
	if (builtAt.has(commit)) return builtAt.get(commit);
	const dir = mkdtempSync(path.join(tmpdir(), "atcommit-"));
	execFileSync("git", ["clone", "--quiet", "--recurse-submodules", root, dir], {
		encoding: "utf8",
	});
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
	builtAt.set(commit, dir);
	return dir;
}
after(() => {
	for (const dir of builtAt.values())
		rmSync(dir, { recursive: true, force: true });
});

/** The creation bytecode this repository builds at a commit, built from that commit. */
function creationCodeAt(commit, key, entry) {
	const artefact = JSON.parse(
		readFileSync(path.join(buildAt(commit), artefactOf(key, entry)), "utf8"),
	);
	return artefact.bytecode.object;
}

/**
 * What an entry of ours records: a creation through the CREATE2 factory, or a mint the deploy plan
 * sent to fund a contract it created. Any other shape is refused by name, so an entry the deploy
 * pipeline learns to write fails here as unread instead of passing as checked.
 */
export function kindOf(key, entry) {
	if ("salt" in entry && "constructorArgs" in entry) return "create2";
	if ("token" in entry && "recipient" in entry && "amount" in entry)
		return "mint";
	throw new Error(`${key}: an entry this test does not know how to check`);
}

/** The input a recorded mint must have sent: mint(recipient, amount) with the recorded values. */
export function mintInput(entry) {
	const selector = "40c10f19"; // mint(address,uint256)
	const recipient = entry.recipient.replace(/^0x/, "").toLowerCase();
	const amount = BigInt(entry.amount).toString(16);
	return `0x${selector}${recipient.padStart(64, "0")}${amount.padStart(64, "0")}`;
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
			const field = (name) =>
				execFileSync("cast", ["tx", entry.txHash, name, "--rpc-url", url], {
					encoding: "utf8",
					maxBuffer: 64 * 1024 * 1024,
				}).trim();
			const sent = field("input");

			if (kindOf(key, entry) === "mint") {
				// A mint is checked by what it sent and where, and that it took effect: the
				// token it names, the recipient and amount it records, in the block it records.
				assert.equal(
					field("to").toLowerCase(),
					entry.token.toLowerCase(),
					`${book} ${key}: the mint was not sent to the token the record names`,
				);
				assert.equal(
					sent.toLowerCase(),
					mintInput(entry),
					`${book} ${key}: the chain and the recorded recipient or amount disagree`,
				);
				assert.equal(
					Number(field("blockNumber")),
					entry.block,
					`${book} ${key}: the mint is not in the block the record names`,
				);
				const receipt = JSON.parse(
					execFileSync(
						"cast",
						["receipt", entry.txHash, "--json", "--rpc-url", url],
						{ encoding: "utf8" },
					),
				);
				assert.equal(
					Number(receipt.status),
					1,
					`${book} ${key}: the mint reverted`,
				);
				continue;
			}

			// The creation input, not the runtime code: a contract with an immutable differs
			// from its artefact by exactly the bytes the constructor wrote.
			const salt = entry.salt.replace(/^0x/, "");
			const code = creationCodeAt(entry.commit, key, entry).replace(/^0x/, "");
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

test("an entry is built from the source it records, and an older entry from the probe script", () => {
	assert.equal(
		artefactOf("MarketFactory", {
			contract: "src/MarketFactory.sol:MarketFactory",
		}),
		path.join("contracts", "out", "MarketFactory.sol", "MarketFactory.json"),
	);
	assert.equal(
		artefactOf("TestnetStock.TSLA", {
			contract: "src/testnet/TestnetStock.sol:TestnetStock",
		}),
		path.join("contracts", "out", "TestnetStock.sol", "TestnetStock.json"),
	);
	assert.equal(
		artefactOf("Probe", {}),
		path.join("contracts", "out", "DeployProbe.s.sol", "Probe.json"),
	);
});

test("a record's entry is read as a creation or as a mint, and any other shape is refused by name", () => {
	assert.equal(
		kindOf("MarketFactory", {
			salt: "0x00",
			constructorArgs: "0x",
			txHash: "0x01",
		}),
		"create2",
	);
	assert.equal(
		kindOf("CreProposer.bonds", {
			token: "0x1125aB2e77C8d4E4082f690176cE8604088813E7",
			recipient: "0x18fC5360598FeED231B2A4936ab72bfc4daA34B7",
			amount: "500000000",
			txHash: "0x01",
		}),
		"mint",
	);
	assert.throws(() => kindOf("Odd", { txHash: "0x01" }), /Odd/);
});

test("a mint entry's expected input is mint(recipient, amount) with the recorded values", () => {
	assert.equal(
		mintInput({
			recipient: "0x18fC5360598FeED231B2A4936ab72bfc4daA34B7",
			amount: "500000000",
		}),
		"0x40c10f1900000000000000000000000018fc5360598feed231b2a4936ab72bfc4daa34b7000000000000000000000000000000000000000000000000000000001dcd6500",
	);
});

test("every role's Safe a record names exists on its chain with the owners and threshold recorded", (t) => {
	const SAFE_OWNERS = "getOwners()(address[])";
	const SAFE_THRESHOLD = "getThreshold()(uint256)";
	let checked = 0;
	for (const book of committedBooks()) {
		const chainId = path.basename(book, ".json");
		const roles = JSON.parse(readFileSync(path.join(root, book), "utf8")).roles;
		if (!roles) continue;
		const url = process.env[readTier[chainId]] ?? fallback[chainId];
		for (const [role, safe] of Object.entries(roles)) {
			const owners = execFileSync(
				"cast",
				["call", safe.address, SAFE_OWNERS, "--rpc-url", url],
				{ encoding: "utf8" },
			)
				.trim()
				.toLowerCase();
			for (const owner of safe.owners)
				assert.ok(
					owners.includes(owner.toLowerCase()),
					`${book} ${role}: ${owner} is not an owner`,
				);
			const threshold = execFileSync(
				"cast",
				["call", safe.address, SAFE_THRESHOLD, "--rpc-url", url],
				{ encoding: "utf8" },
			).trim();
			assert.equal(
				Number(threshold),
				safe.threshold,
				`${book} ${role}: threshold`,
			);
			checked++;
		}
	}
	if (checked === 0) t.diagnostic("unarmed: no record names a role's Safe yet");
});
