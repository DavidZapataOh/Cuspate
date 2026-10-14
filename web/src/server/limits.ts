/**
 * How much gas the app pays for, per user and in all: a number of paid batches per user per UTC
 * day, and a number of paid batches across all users per UTC month. The counts are kept in a
 * durable store, never in the memory of one server instance, because each request may land on a
 * fresh one. A batch is counted when it is reserved, before it is sent, so a send that then fails
 * still counts: the limits can only err towards paying for less.
 */
import "server-only";

/** Paid batches per user per UTC day: a buy takes one, so a day of active trading fits, and abuse is cut short. */
export const DAILY_BATCHES_PER_USER = 20;

/** Paid batches across all users per UTC month: a measured buy or undo uses about 0.85M gas, so at most about 4.3 billion gas a month. */
export const MONTHLY_BATCHES_GLOBAL = 5_000;

/** How many batches were paid for within one period. */
export type Tally = { period: string; count: number };

/** Whose tally: one user's, or everyone's. */
export type TallyKey = { user: string } | "global";

/** Where tallies are kept between requests. */
export type TallyStore = {
	read(key: TallyKey): Promise<Tally | undefined>;
	write(key: TallyKey, tally: Tally): Promise<void>;
};

/** Which limit a request reached, or nothing when it may be paid for. */
export type Reached = "user" | "global" | undefined;

/** What the route asks before paying for a batch. */
export type SponsorLimits = {
	/** Counts one batch for the user and in all, unless a limit is reached, which it then names. */
	reserve(userId: string): Promise<Reached>;
};

/** The UTC day a moment falls on, as YYYY-MM-DD. */
export function dayOf(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/** The UTC month a moment falls on, as YYYY-MM. */
export function monthOf(now: Date): string {
	return now.toISOString().slice(0, 7);
}

function within(tally: Tally | undefined, period: string): number {
	return tally?.period === period ? tally.count : 0;
}

/**
 * The limits over a store. Reading and then writing is not atomic, so requests that arrive at the
 * same moment can each pass on the same count; the overshoot is at most the number in flight.
 */
export function sponsorLimits(
	store: TallyStore,
	now: () => Date = () => new Date(),
): SponsorLimits {
	return {
		async reserve(userId) {
			const at = now();
			const day = dayOf(at);
			const month = monthOf(at);
			const [mine, all] = await Promise.all([
				store.read({ user: userId }),
				store.read("global"),
			]);
			const used = within(mine, day);
			const spent = within(all, month);
			if (used >= DAILY_BATCHES_PER_USER) return "user";
			if (spent >= MONTHLY_BATCHES_GLOBAL) return "global";
			await store.write({ user: userId }, { period: day, count: used + 1 });
			await store.write("global", { period: month, count: spent + 1 });
			return undefined;
		},
	};
}
