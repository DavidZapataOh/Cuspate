import { describe, expect, test } from "bun:test";

const root = `${import.meta.dir}/fixtures`;

type Provenance = {
	documents: { file: string; url: string; fetched: string; sha256: string }[];
};

/** Every recorded document, by its path under the fixtures directory. */
function recorded(): string[] {
	return [...new Bun.Glob("**/*.{htm,html,xml}").scanSync(root)].sort();
}

/** Every provenance file's documents, by path under the fixtures directory. */
async function listed(): Promise<Map<string, Provenance["documents"][number]>> {
	const documents = new Map<string, Provenance["documents"][number]>();
	const files = [...new Bun.Glob("**/provenance.json").scanSync(root)];
	for (const file of files) {
		const directory = file.includes("/") ? `${file.split("/")[0]}/` : "";
		const provenance: Provenance = await Bun.file(`${root}/${file}`).json();
		for (const document of provenance.documents)
			documents.set(`${directory}${document.file}`, document);
	}
	return documents;
}

describe("the recorded documents", () => {
	test("each is listed with where it was fetched from, and listed once", async () => {
		const documents = await listed();
		expect([...documents.keys()].sort()).toEqual(recorded());
		for (const document of documents.values())
			expect(document.url).toMatch(/^https:\/\/www\.sec\.gov\//);
	});

	test("each is byte for byte the document that was fetched", async () => {
		for (const [path, document] of await listed()) {
			const bytes = await Bun.file(`${root}/${path}`).bytes();
			expect(
				new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
				path,
			).toBe(document.sha256);
		}
	});
});
