/**
 * The ABIs the indexer decodes with, copied out of the contracts' build output into the indexer's own
 * folder. A hosted build receives this folder alone, from what is committed, so the configuration
 * can point at nothing above it and nothing the build output ignores.
 *
 *   node scripts/abis.ts            copies them, after the contracts are built
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const indexer = path.resolve(import.meta.dirname, "..");
const PATH = /^\s*abi_file_path: \.\/abis\/(\w+)\.json$/gm;

/** Every contract the base configuration decodes, with its committed and its built ABI's paths. */
export function vendored(): {
	name: string;
	committed: string;
	built: string;
}[] {
	const config = readFileSync(path.join(indexer, "config.yaml"), "utf8");
	return [...config.matchAll(PATH)].map(([, name]) => ({
		name,
		committed: path.join(indexer, "abis", `${name}.json`),
		built: path.join(
			indexer,
			"../contracts/out",
			`${name}.sol`,
			`${name}.json`,
		),
	}));
}

/** A contract's ABI as the compiler wrote it. */
export function builtAbi(file: string): unknown {
	return JSON.parse(readFileSync(file, "utf8")).abi;
}

if (import.meta.filename === process.argv[1]) {
	for (const { committed, built } of vendored())
		writeFileSync(
			committed,
			`${JSON.stringify(builtAbi(built), null, "\t")}\n`,
		);
}
