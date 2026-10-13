/**
 * The contracts' build output, read by source and name: what the runbook deploys is exactly what the
 * repository builds, with nothing compiled anywhere else.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

/** The contracts' project directory. */
export const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../contracts",
);

/** A contract's ABI and creation code, by its source, `path/File.sol:Name`. */
export function artifact(source: string): { abi: Abi; bytecode: Hex } {
	const [file, name] = source.split(":");
	if (!file || !name) throw new Error(`not a source and name: ${source}`);
	const json = JSON.parse(
		readFileSync(
			path.join(contractsDir, "out", path.basename(file), `${name}.json`),
			"utf8",
		),
	);
	return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
}
