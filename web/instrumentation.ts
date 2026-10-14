/**
 * Starts reading the chain when the server starts, so the first visitor does not wait for the scan
 * of the pools' history.
 */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { readLayer } = await import("./src/data/read.ts");
	readLayer()
		.warm?.()
		.catch(() => {
			// A failed warm-up is retried by the first page that reads.
		});
}
