"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { encodeFunctionData, formatUnits, parseAbi } from "viem";
import { useConfig, useConnection, usePublicClient } from "wagmi";
import {
	checkPurchase,
	fundsOf,
	quoteShares,
	roomCents,
} from "../chain/market.ts";
import { contracts, TESTNET } from "../chain/record.ts";
import type { Condition, MarketEvent } from "../data/model.ts";
import { walletExecutor } from "./executor.ts";
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
	const { address } = useConnection();
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
	};

	const refresh = () =>
		Promise.all(
			["quote", "funds", "room"].map((key) =>
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
			const executor = walletExecutor(config, address);
			const submitted = await executor.send(calls);
			setPhase({ kind: "pending" });
			const settled = await executor.settle(submitted);
			setPhase(
				settled.status === "confirmed"
					? { kind: "done", shares }
					: { kind: "failed", problem: { kind: "failed" } },
			);
		} catch {
			setPhase({ kind: "failed", problem: problemOf(undefined) });
		} finally {
			await refresh();
		}
	}

	const [dripping, setDripping] = useState(false);
	async function getTestDollars() {
		if (!address) return;
		setDripping(true);
		try {
			const executor = walletExecutor(config, address);
			await executor.settle(
				await executor.send([{ to: contracts.dollar, data: drip, value: 0n }]),
			);
		} catch {
			// The ticket keeps saying how many dollars are missing; nothing else changed.
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
		/** Back to a fresh ticket after the amount or the world changes. */
		reset: () =>
			setPhase((p) =>
				p.kind === "checking" || p.kind === "signing" || p.kind === "pending"
					? p
					: { kind: "idle" },
			),
	};
}
