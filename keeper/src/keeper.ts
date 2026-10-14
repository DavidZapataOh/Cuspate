/**
 * The keeper: keeps one market's implied price within the band around the feed's quote, one atomic
 * correction at a time, and never makes one twice.
 *
 * Each step first finishes what a previous step, or a previous run, left pending: a batch signed for
 * the Safe's nonce is spent once that nonce has moved, whoever moved it, and is resubmitted once with a
 * fresh key nonce if the key nonce it was sent with was consumed by another transaction. Only then is a
 * new correction considered.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import type { LocalAccount } from "viem/accounts";
import { ERC20 } from "./abis.ts";
import { executionData, isSpent, signBatch } from "./account.ts";
import { band, type IdleReason, idleReason } from "./arithmetic.ts";
import {
	type Call,
	type Correction,
	cheapBatch,
	quoteCheap,
	quoteRich,
	richBatch,
} from "./correction.ts";
import {
	type Deployment,
	type Market,
	readFreeze,
	readImplied,
	readQuote,
	readRoom,
} from "./market.ts";
import type { Simulator } from "./simulator.ts";
import type { Pending, Store } from "./store.ts";

/** What a step did. */
export type Outcome =
	| { kind: "idle"; reason: IdleReason | "in-band" | "no-room" }
	| { kind: "corrected" | "superseded"; rich?: boolean; hash?: Hex }
	| { kind: "waiting"; hash?: Hex }
	| { kind: "abandoned" };

export type KeeperOptions = {
	client: PublicClient;
	wallet: WalletClient;
	owner: LocalAccount;
	safe: Address;
	multiSend: Address;
	deployment: Deployment;
	market: Market;
	simulator: Simulator;
	store: Store;
	/** The largest correction, in shares, one step makes. */
	clip: bigint;
	/** How long to wait for a receipt before leaving the batch pending for the next step. */
	receiptTimeoutMs: number;
};

const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));

/** The most a quote can ask for: the quoter takes amounts as 128-bit integers. */
const MAX_QUOTE = (1n << 128n) - 1n;

export class Keeper {
	private readonly o: KeeperOptions;

	constructor(options: KeeperOptions) {
		this.o = options;
	}

	private get id() {
		return this.o.market.marketId;
	}

	/** One step: finish what is pending, or correct the market if it is out of the band. */
	async step(): Promise<Outcome> {
		const pending = this.o.store.pending(this.id);
		if (pending) return this.finish(pending);
		const signed = await this.prepare();
		if ("kind" in signed) return signed;
		return this.finish(signed);
	}

	/** Decides, sizes, signs and records a correction, without sending it. */
	async prepare(): Promise<Pending | Extract<Outcome, { kind: "idle" }>> {
		const { client, deployment, market } = this.o;
		const head = await client.getBlock();
		const quote = await readQuote(client, deployment, market);
		const idle = idleReason(
			quote,
			head.timestamp,
			await readFreeze(client, deployment, market),
		);
		if (idle) return { kind: "idle", reason: idle };
		const { lower, upper } = band(quote.bid, quote.ask);
		const implied = await readImplied(client, deployment, market);
		if (implied >= lower && implied <= upper)
			return { kind: "idle", reason: "in-band" };
		const deadline = head.timestamp + 300n;
		await this.o.simulator.reset();
		const correction =
			implied > upper
				? await this.sizeRich(upper, deadline)
				: await this.sizeCheap(lower, deadline);
		if (correction === null) return { kind: "idle", reason: "no-room" };
		const batch = this.batch(correction, deadline);
		const signed = await signBatch(
			client,
			this.o.owner,
			this.o.safe,
			this.o.multiSend,
			batch,
		);
		const pending: Pending = {
			...signed,
			keyNonce: await client.getTransactionCount({
				address: this.o.owner.address,
				blockTag: "latest",
			}),
			resubmitted: false,
		};
		this.o.store.record(this.id, pending);
		return pending;
	}

	/** Sends a pending batch if it still can execute, waits for it, and forgets it once spent. */
	async finish(pending: Pending): Promise<Outcome> {
		const { client, store } = this.o;
		if (await isSpent(client, pending)) {
			store.clear(this.id);
			return { kind: "superseded" };
		}
		const keyNonce = await client.getTransactionCount({
			address: this.o.owner.address,
			blockTag: "latest",
		});
		let current = pending;
		if (keyNonce > pending.keyNonce) {
			// The key nonce it was sent with is spent and the batch is not: another transaction took it.
			if (pending.resubmitted) {
				store.clear(this.id);
				return { kind: "abandoned" };
			}
			current = { ...pending, keyNonce, resubmitted: true };
			store.record(this.id, current);
		}
		const hash = await this.o.wallet.sendTransaction({
			account: this.o.owner,
			to: current.safe,
			data: executionData(current),
			nonce: current.keyNonce,
			// The network charges the limit, not what is used, so it is estimated rather than fixed.
			gas:
				((await client.estimateGas({
					account: this.o.owner.address,
					to: current.safe,
					data: executionData(current),
				})) *
					5n) /
				4n,
			chain: null,
		});
		try {
			await client.waitForTransactionReceipt({
				hash,
				timeout: this.o.receiptTimeoutMs,
			});
		} catch {
			return { kind: "waiting", hash };
		}
		if (!(await isSpent(client, current))) return { kind: "waiting", hash };
		store.clear(this.id);
		return { kind: "corrected", hash };
	}

	private batch(c: Correction, deadline: bigint): Call[] {
		const { deployment, market, safe } = this.o;
		return c.rich
			? richBatch(deployment, market, safe, c, deadline)
			: cheapBatch(deployment, market, safe, c, deadline);
	}

	private impliedAfter(c: Correction, deadline: bigint): Promise<bigint> {
		return this.o.simulator
			.tryBatch(this.o.safe, this.batch(c, deadline), (reader) =>
				readImplied(reader, this.o.deployment, this.o.market),
			)
			.then((implied) => implied ?? 0n);
	}

	/**
	 * The smallest rich correction that brings the implied price to the band's upper edge, within the
	 * account's underlying, the vault's room and the clip; the whole allowance if even that does not.
	 */
	private async sizeRich(
		target: bigint,
		deadline: bigint,
	): Promise<Correction | null> {
		const { client, deployment, market, safe } = this.o;
		let high = min(
			await client.readContract({
				address: market.underlying,
				abi: ERC20,
				functionName: "balanceOf",
				args: [safe],
			}),
			await readRoom(client, market.underlyingVault, market.legs.underlyingYes),
			this.o.clip,
		);
		if (high === 0n) return null;
		if (
			(await this.impliedAfter(
				await quoteRich(client, deployment, market, high),
				deadline,
			)) > target
		) {
			return quoteRich(client, deployment, market, high);
		}
		let low = 0n;
		while (high - low > 1n) {
			const middle = (low + high) / 2n;
			if (
				(await this.impliedAfter(
					await quoteRich(client, deployment, market, middle),
					deadline,
				)) <= target
			)
				high = middle;
			else low = middle;
		}
		return quoteRich(client, deployment, market, high);
	}

	/**
	 * The smallest cheap correction that brings the implied price to the band's lower edge, within the
	 * account's dollars, the dollar vault's room and the clip; the whole allowance if even that does not.
	 */
	private async sizeCheap(
		target: bigint,
		deadline: bigint,
	): Promise<Correction | null> {
		const { client, deployment, market, safe } = this.o;
		const dollars = await client.readContract({
			address: market.dollar,
			abi: ERC20,
			functionName: "balanceOf",
			args: [safe],
		});
		const room = await readRoom(
			client,
			market.dollarVault,
			market.legs.dollarYes,
		);
		// The largest size the dollars and the room can pay for, halving from the most a quote can ask;
		// a size no pool can fill is a quote that reverts, and is as unaffordable as one too dear.
		const affordable = async (shares: bigint) => {
			try {
				const c = await quoteCheap(client, deployment, market, shares);
				return c.yesOut + c.noOut <= dollars && c.yesOut + c.noOut <= room;
			} catch {
				return false;
			}
		};
		let high = min(this.o.clip, MAX_QUOTE);
		while (high > 0n && !(await affordable(high))) high /= 2n;
		if (high === 0n) return null;
		if (
			(await this.impliedAfter(
				await quoteCheap(client, deployment, market, high),
				deadline,
			)) < target
		) {
			return quoteCheap(client, deployment, market, high);
		}
		let low = 0n;
		while (high - low > 1n) {
			const middle = (low + high) / 2n;
			if (
				(await this.impliedAfter(
					await quoteCheap(client, deployment, market, middle),
					deadline,
				)) >= target
			)
				high = middle;
			else low = middle;
		}
		return quoteCheap(client, deployment, market, high);
	}
}
