/**
 * How a request for a deposit address proves it comes from the address it names: an email session's
 * token, which the server checks with the wallet provider, or a signature by a connected wallet over
 * a message naming the address and the moment, which the server checks on chain. Pure, so the
 * message and the checks are tested.
 */

/** How long a signed request stays good, in milliseconds. */
export const PROOF_MAX_AGE_MS = 5 * 60_000;

/** The message a connected wallet signs to ask for a deposit address to itself. */
export function proofMessage(address: string, signedAt: number): string {
	return `Cuspate: open a deposit address that sends dollars to ${address.toLowerCase()}. Signed at ${signedAt}.`;
}

/** Whether a signature's moment is recent enough, and not from the future beyond a minute. */
export function freshProof(signedAt: number, now: number): boolean {
	return (
		Number.isFinite(signedAt) &&
		signedAt <= now + 60_000 &&
		now - signedAt <= PROOF_MAX_AGE_MS
	);
}

/** At most this many deposit addresses per address in each window. */
export const QUOTES_PER_WINDOW = 5;
/** The window, in milliseconds. */
export const QUOTE_WINDOW_MS = 10 * 60_000;

/**
 * Takes one of an address's slots for a deposit address, or refuses when its window is full.
 * @param log When each address last took its slots, kept by the caller.
 * @returns whether the slot was taken, and when the next one frees when it was not.
 */
export function takeSlot(
	log: Map<string, number[]>,
	address: string,
	now: number,
): { ok: true } | { ok: false; retryAt: number } {
	const key = address.toLowerCase();
	const recent = (log.get(key) ?? []).filter((t) => now - t < QUOTE_WINDOW_MS);
	if (recent.length >= QUOTES_PER_WINDOW) {
		log.set(key, recent);
		return { ok: false, retryAt: (recent[0] ?? now) + QUOTE_WINDOW_MS };
	}
	recent.push(now);
	log.set(key, recent);
	return { ok: true };
}
