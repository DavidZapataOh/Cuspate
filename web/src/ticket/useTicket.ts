"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { encodeFunctionData, formatUnits, parseAbi } from "viem";
import { useConfig, useConnection, usePublicClient } from "wagmi";
import {
	checkPurchase,
	fundsOf,
	nextDripAt,
	quoteShares,
	receivedShares,
	roomCents,
} from "../chain/market.ts";
import { contracts, TESTNET } from "../chain/record.ts";
import type { Condition, MarketEvent } from "../data/model.ts";
import { minimumCents } from "../lib/ticket.ts";
import { useEmailSession } from "../wallet/EmailSession.tsx";
import {
	type Executor,
	sponsoredExecutor,
	walletExecutor,
} from "./executor.ts";
import {
	centsToDollarUnits,
	deadlineFor,
	entryCalls,
	floorOf,
} from "./order.ts";
import { problemOf } from "./problems.ts";
import { type Phase, type TicketInput, ticketView } from "./view.ts";

const REFRESH_MS = 15_000;
const drip = encodeFunctionData({
	abi: parseAbi(["function drip()"]),
	functionName: "drip",
});

/** Six-decimal dollar units as whole cents, rounded down. */
const toCents = (units: bigint) => units / 10_000n;

/**
 * A ticket's live state: the quote, the wallet's dollars and the market's room, kept fresh, and the
 * two actions, buying and taking the test dollars. Every purchase is checked against the chain,
 * approval included, before the wallet is asked to sign.
 */
export function useTicket({
	event,
	condition,
	amountCents,
	yes,
}: {
	event: Pick<MarketEvent, "issuer" | "announcesAt">;
	condition: Condition;
	amountCents: bigint | undefined;
	yes: boolean;
}) {
	const market = condition.market;
	const client = usePublicClient({ chainId: TESTNET.id });
	const config = useConfig();
	const { address: connected } = useConnection();
	const { session } = useEmailSession();
	// An email session buys through the server, gas paid; a connected wallet signs and pays itself.
	const address = session?.address ?? connected;
	const executorFor = (account: NonNullable<typeof address>): Executor =>
		session
			? sponsoredExecutor({ token: async () => session.token })
			: walletExecutor(config, account);
	const queries = useQueryClient();
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const dollars = amountCents ? centsToDollarUnits(amountCents) : 0n;
	const ready = Boolean(market && client);

	const quote = useQuery({
		queryKey: ["quote", market?.marketId, yes, dollars.toString()],
		enabled: ready && dollars > 0n,
		refetchInterval: REFRESH_MS,
		queryFn: () =>
			quoteShares(
				client as NonNullable<typeof client>,
				(market as NonNullable<typeof market>).legs,
				yes,
				dollars,
			),
	});
	const funds = useQuery({
		queryKey: ["funds", address],
		enabled: ready && Boolean(address),
		refetchInterval: REFRESH_MS,
		queryFn: () =>
			fundsOf(
				client as NonNullable<typeof client>,
				address as NonNullable<typeof address>,
			),
	});
	const room = useQuery({
		queryKey: ["room", market?.dollarVault],
		enabled: ready,
		refetchInterval: REFRESH_MS,
		queryFn: () =>
			roomCents(
				client as NonNullable<typeof client>,
				(market as NonNullable<typeof market>).dollarVault,
			),
	});

	const dripAt = useQuery({
		queryKey: ["drip", address],
		enabled: ready && Boolean(address),
		refetchInterval: REFRESH_MS,
		queryFn: () =>
			nextDripAt(
				client as NonNullable<typeof client>,
				address as NonNullable<typeof address>,
			),
	});
	const [dripProblem, setDripProblem] = useState<string | undefined>();

	const input: TicketInput = {
		live: Boolean(market),
		amountCents,
		yes,
		condition: { ...condition, issuer: event.issuer },
		quote: quote.data,
		account: address,
		balanceCents: funds.data ? toCents(funds.data.balance) : undefined,
		roomCents: room.data,
		nowMs: Date.now(),
		announcesAt: event.announcesAt,
		phase,
		minimumCents: minimumCents(
			yes ? condition.yesWorldPriceCents : condition.noWorldPriceCents,
		),
	};

	const refresh = () =>
		Promise.all(
			["quote", "funds", "room", "drip"].map((key) =>
				queries.invalidateQueries({ queryKey: [key] }),
			),
		);

	async function buy() {
		if (
			!market ||
			!client ||
			!address ||
			!quote.data ||
			!("shares" in quote.data)
		)
			return;
		const shares = quote.data.shares;
		setPhase({ kind: "checking" });
		try {
			const now = BigInt(Math.floor(Date.now() / 1000));
			const { allowance } = await fundsOf(client, address);
			const calls = entryCalls({
				router: contracts.router,
				dollar: contracts.dollar,
				marketId: market.marketId,
				yes,
				dollars,
				minShares: floorOf(shares),
				recipient: address,
				deadline: deadlineFor(
					now,
					BigInt(Date.parse(event.announcesAt) / 1000),
				),
				allowance,
			});
			const problem = await checkPurchase(client, address, calls);
			if (problem) {
				setPhase({ kind: "failed", problem });
				return;
			}
			setPhase({ kind: "signing" });
			const sentFrom = await client.getBlockNumber();
			const executor = executorFor(address);
			const submitted = await executor.send(calls);
			setPhase({ kind: "pending" });
			const settled = await executor.settle(submitted);
			if (settled.status !== "confirmed") {
				// Checked before signing, so a purchase that fails on chain met a price that moved.
				setPhase({ kind: "failed", problem: { kind: "moved" } });
				return;
			}
			// What the router logged it bought, not what the quote said it would.
			const bought = await receivedShares(
				client,
				market.marketId,
				address,
				sentFrom,
			).catch(() => undefined);
			setPhase({ kind: "done", shares: bought ?? shares });
		} catch (error) {
			setPhase({ kind: "failed", problem: problemOf(undefined, error) });
		} finally {
			await refresh();
		}
	}

	const [dripping, setDripping] = useState(false);
	async function getTestDollars() {
		if (!address) return;
		setDripping(true);
		setDripProblem(undefined);
		try {
			const executor = executorFor(address);
			const settled = await executor.settle(
				await executor.send([{ to: contracts.dollar, data: drip, value: 0n }]),
			);
			if (settled.status !== "confirmed")
				setDripProblem("The test dollars did not arrive. Try again.");
		} catch (error) {
			setDripProblem(
				problemOf(undefined, error).kind === "cancelled"
					? "You cancelled the signature."
					: "The test dollars did not arrive. Try again.",
			);
		} finally {
			setDripping(false);
			await refresh();
		}
	}

	return {
		view: ticketView(input),
		/** The quoted shares as a number, once quoted. */
		quotedShares:
			quote.data && "shares" in quote.data
				? Number(formatUnits(quote.data.shares, 18))
				: undefined,
		buy,
		getTestDollars,
		dripping,
		/** When test dollars can be taken again, in seconds, while the faucet's day has not passed. */
		dripLockedUntil:
			dripAt.data !== undefined && dripAt.data * 1000 > Date.now()
				? dripAt.data
				: undefined,
		/** Why the last request for test dollars did not go through, if it did not. */
		dripProblem,
		/** Back to a fresh ticket after the amount or the world changes. */
		reset: () =>
			setPhase((p) =>
				p.kind === "checking" || p.kind === "signing" || p.kind === "pending"
					? p
					: { kind: "idle" },
			),
	};
}
