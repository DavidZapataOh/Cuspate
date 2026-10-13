/**
 * What the keeper must remember across a restart: the batch it signed and has not seen spent, and the
 * key nonce it sent it with. Written before anything is sent, so a restart finds it. One file per
 * market, and a lock file so that one machine runs one instance at a time.
 */
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { SignedBatch } from "./account.ts";

/** A batch signed and possibly sent, not yet seen spent. */
export type Pending = SignedBatch & {
	keyNonce: number;
	sentAt?: number;
	resubmitted: boolean;
};

const replacer = (_: string, value: unknown) =>
	typeof value === "bigint" ? { bigint: value.toString() } : value;
const reviver = (_: string, value: unknown) =>
	value !== null && typeof value === "object" && "bigint" in value
		? BigInt((value as { bigint: string }).bigint)
		: value;

export class Store {
	private readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
		mkdirSync(directory, { recursive: true });
	}

	private file(market: string) {
		return path.join(this.directory, `${market}.json`);
	}

	/** The pending batch for a market, if any. */
	pending(market: string): Pending | undefined {
		const file = this.file(market);
		return existsSync(file)
			? (JSON.parse(readFileSync(file, "utf8"), reviver) as Pending)
			: undefined;
	}

	/** Records a pending batch, atomically: a crash leaves the old record or the new, never half. */
	record(market: string, pending: Pending) {
		const file = this.file(market);
		writeFileSync(`${file}.tmp`, JSON.stringify(pending, replacer));
		renameSync(`${file}.tmp`, file);
	}

	/** Forgets a market's pending batch, once it is spent. */
	clear(market: string) {
		rmSync(this.file(market), { force: true });
	}

	/** Takes the instance lock, or returns false if another instance holds it. */
	lock(): boolean {
		try {
			closeSync(openSync(path.join(this.directory, "keeper.lock"), "wx"));
			return true;
		} catch {
			return false;
		}
	}

	/** Releases the instance lock. */
	unlock() {
		rmSync(path.join(this.directory, "keeper.lock"), { force: true });
	}
}
