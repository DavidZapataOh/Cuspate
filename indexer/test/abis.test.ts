/**
 * The committed ABIs are the contracts' own: each equals what the compiler writes for it, and the
 * configurations name no ABI outside the indexer's folder.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { builtAbi, vendored } from "../scripts/abis";

const indexer = path.resolve(import.meta.dirname, "..");

describe("committed ABIs", () => {
	test("the base configuration decodes every contract with a committed ABI", () => {
		const config = readFileSync(path.join(indexer, "config.yaml"), "utf8");
		const named = [...config.matchAll(/abi_file_path: (.+)$/gm)].map(
			(m) => m[1],
		);
		expect(named.length).toBe(8);
		expect(vendored().map((v) => `./abis/${v.name}.json`)).toEqual(named);
	});

	test.each(vendored())(
		"$name equals the build output (run `node scripts/abis.ts` after a build)",
		({ committed, built }) => {
			expect(JSON.parse(readFileSync(committed, "utf8"))).toEqual(
				builtAbi(built),
			);
		},
	);

	test("every committed network configuration reads the same ABIs as the base", () => {
		const paths = (file: string) =>
			[
				...readFileSync(path.join(indexer, file), "utf8").matchAll(
					/abi_file_path: (.+)$/gm,
				),
			].map((m) => m[1]);
		expect(paths("config.10143.yaml")).toEqual(paths("config.yaml"));
	});
});
