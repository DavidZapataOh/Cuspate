import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TEST_WALLET_NAME, TEST_WALLET_RDNS } from "./fork/wallet.ts";

/** Every file the browser can be served, from the production build. */
function shipped(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const file = path.join(dir, name);
		return statSync(file).isDirectory() ? shipped(file) : [file];
	});
}

test("the production build ships no test wallet and no mock connector", async ({
	browserName,
}) => {
	test.skip(browserName !== "chromium", "a file check, once");
	const files = shipped(path.join(process.cwd(), ".next", "static"));
	expect(files.length).toBeGreaterThan(0);
	const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
	for (const marker of [
		TEST_WALLET_NAME,
		TEST_WALLET_RDNS,
		'type:"mock"',
		"mockConnector",
	])
		expect(text.includes(marker), marker).toBe(false);
});
