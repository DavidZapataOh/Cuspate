/**
 * A network's address book, `contracts/deployments/<chain>.json`: a person writes its manifest and
 * third-party addresses, and only the runbook writes what it deployed, entry by entry, from receipts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { contractsDir } from "./artifacts.ts";
import type { Manifest, Role } from "./plan.ts";

/** One contract the runbook created through the deterministic deployer. */
export type Generated = {
	address: Address;
	factory: Address;
	salt: Hex;
	contract: string;
	constructorArgs: Hex;
	block: number;
	txHash: Hex;
	commit: string;
};

/** One role's Safe, created through the proxy factory. */
export type RoleEntry = {
	address: Address;
	factory: Address;
	singleton: Address;
	saltNonce: string;
	owners: Address[];
	threshold: number;
	block: number;
	txHash: Hex;
};

export type Book = {
	manifest?: Manifest & { placeholders?: boolean };
	thirdParty?: Record<string, Address[]>;
	roles?: Partial<Record<Role, RoleEntry>>;
	[key: string]: unknown;
};

/** The committed book of a chain. */
export function committedPath(chainId: number): string {
	return path.join(contractsDir, "deployments", `${chainId}.json`);
}

/** A rehearsal's book, outside version control. */
export function rehearsalPath(chainId: number): string {
	return path.join(
		contractsDir,
		"deployments",
		".rehearsal",
		`${chainId}.json`,
	);
}

export function readBook(file: string): Book {
	return existsSync(file)
		? (JSON.parse(readFileSync(file, "utf8")) as Book)
		: {};
}

function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
		);
	return value;
}

/** Writes a book with its keys sorted, so a record changes only where its content does. */
export function writeBook(file: string, book: Book): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(sorted(book), null, 2)}\n`);
}

/** The manifest and third parties of a chain, which a rehearsal copies before it records anything. */
export function manifestOf(
	chainId: number,
): Manifest & { placeholders?: boolean } {
	const book = readBook(committedPath(chainId));
	if (!book.manifest || !book.thirdParty)
		throw new Error(`contracts/deployments/${chainId}.json has no manifest`);
	return { ...book.manifest, thirdParty: book.thirdParty };
}
