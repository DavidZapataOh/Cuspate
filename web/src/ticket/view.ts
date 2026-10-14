/**
 * What the ticket shows in each state, from everything it knows: whether the market is open on
 * chain, the amount, the quote, the wallet and its dollars, the room left, the clock, and where a
 * purchase has got to. Pure, so every state's words are tested; the component only renders them.
 */
import { type Address, formatUnits } from "viem";
import { formatShares, formatUsd } from "../lib/format.ts";
import { buttonWords, panLabels } from "../lib/naming.ts";
import { type Problem, problemText } from "./problems.ts";

/** Where a purchase has got to. */
export type Phase =
	| { kind: "idle" }
	| { kind: "checking" }
	| { kind: "signing" }
	| { kind: "pending" }
	| { kind: "done"; shares: bigint }
	| { kind: "failed"; problem: Problem };

/** Everything the ticket's words depend on. */
export type TicketInput = {
	/** Whether the condition's market is open on chain; without one the ticket only previews. */
	live: boolean;
	/** The amount typed, in cents; nothing while it is empty or unreadable. */
	amountCents: bigint | undefined;
	/** Which world is bought: the condition holding, or not. */
	yes: boolean;
	condition: {
		issuer: string;
		threshold: bigint;
		decimals: number;
		primary: boolean;
	};
	/** The quote for the amount: shares in eighteen decimals, a refusal, or nothing while it comes. */
	quote: { shares: bigint } | { problem: Problem } | undefined;
	account: Address | undefined;
	/** The wallet's test dollars and the market's room left, in cents, once read. */
	balanceCents: bigint | undefined;
	roomCents: bigint | undefined;
	nowMs: number;
	announcesAt: string;
	phase: Phase;
};

/** The state a ticket is in. */
export type TicketState =
	| "preview"
	| "closed"
	| "empty"
	| "quoting"
	| "connect"
	| "short"
	| "full"
	| "ready"
	| "checking"
	| "signing"
	| "pending"
	| "done"
	| "failed";

/** What the ticket renders. */
export type TicketView = {
	state: TicketState;
	buy: { label: string; disabled: boolean; busy: boolean; signsIn: boolean };
	/** The quiet link that switches to the other world. */
	other: string;
	/** One line under the actions; empty when there is nothing to say. */
	status: string;
	/** Whether to offer the test network's free test dollars. */
	offerTestDollars: boolean;
};

/** Both outcomes of buying with these shares, in the condition's own words. */
function outcomes(input: TicketInput, shares: bigint): string {
	const [holds, fails] = panLabels(input.condition, input.condition);
	const bought = `${formatShares(Number(formatUnits(shares, 18)))} ${input.condition.issuer} shares`;
	const back = `${formatUsd(input.amountCents ?? 0n)} back`;
	return input.yes
		? `${holds}: ${bought}. ${fails}: ${back}.`
		: `${fails}: ${bought}. ${holds}: ${back}.`;
}

/** The ticket's state and words. */
export function ticketView(input: TicketInput): TicketView {
	const words = buttonWords(input.condition, input.condition, input.yes);
	const view = (
		state: TicketState,
		status: string,
		buy: Partial<TicketView["buy"]> = {},
		offerTestDollars = false,
	): TicketView => ({
		state,
		status,
		other: words.other,
		offerTestDollars,
		buy: {
			label: words.buy,
			disabled: true,
			busy: false,
			signsIn: false,
			...buy,
		},
	});
	if (!input.live)
		return view("preview", "Buying opens once this market is live.");
	const closesAt = Date.parse(input.announcesAt);
	if (input.nowMs >= closesAt)
		return view(
			"closed",
			problemText({ kind: "closed", at: Math.floor(closesAt / 1000) }),
		);
	const amount = input.amountCents;
	if (amount === undefined || amount === 0n)
		return view("empty", "Enter an amount to see both outcomes.");
	const { phase } = input;
	if (phase.kind === "checking")
		return view("checking", "", { label: "Checking...", busy: true });
	if (phase.kind === "signing")
		return view("signing", "", { label: "Confirm in your wallet", busy: true });
	if (phase.kind === "pending")
		return view("pending", "", { label: "Buying...", busy: true });
	if (phase.kind === "done")
		return view("done", `Bought. ${outcomes(input, phase.shares)}`, {
			disabled: false,
		});
	if (phase.kind === "failed")
		return view("failed", problemText(phase.problem), { disabled: false });
	if (input.quote === undefined)
		return view("quoting", "Getting a price...", { busy: true });
	if ("problem" in input.quote) {
		const { problem } = input.quote;
		const state =
			problem.kind === "closed"
				? "closed"
				: problem.kind === "full"
					? "full"
					: "failed";
		return view(state, problemText(problem));
	}
	if (!input.account)
		return view("connect", outcomes(input, input.quote.shares), {
			label: "Sign in to buy",
			disabled: false,
			signsIn: true,
		});
	if (input.roomCents !== undefined && input.roomCents < amount)
		return view(
			"full",
			problemText({ kind: "full", roomCents: input.roomCents }),
		);
	if (input.balanceCents !== undefined && input.balanceCents < amount)
		return view(
			"short",
			problemText({ kind: "short", needCents: amount - input.balanceCents }),
			{},
			true,
		);
	return view("ready", outcomes(input, input.quote.shares), {
		disabled: false,
	});
}
