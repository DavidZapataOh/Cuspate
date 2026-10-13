import { type EvmOnEventContext, indexer } from "envio";
import { key, logId, proposalId } from "../ids";

const ZERO = "0x0000000000000000000000000000000000000000";

// Each event's resolution mirrors the resolver's own record of it, round by round, as its events
// report the changes. The bonds it owes are not re-derived here: they follow from its rules, and
// the chain answers `owed` directly.

type Context = EvmOnEventContext;

async function resolutionOf(context: Context, eventId: string) {
	return context.Resolution.getOrCreate({
		id: eventId,
		round: 0,
		pendingArbitration: false,
		outcomeReason: "",
	});
}

async function proposalOf(context: Context, eventId: string, round: number) {
	return context.Proposal.getOrThrow(
		proposalId(eventId, round),
		`no proposal in round ${round} of ${eventId}`,
	);
}

async function propose(
	context: Context,
	eventId: string,
	proposer: string,
	at: number,
	invalid: boolean,
	figure: bigint,
	decimals: number,
) {
	const resolution = await resolutionOf(context, eventId);
	context.Proposal.set({
		id: proposalId(eventId, resolution.round),
		resolution: eventId,
		round: resolution.round,
		proposer: key(proposer),
		proposedAt: BigInt(at),
		invalid,
		settled: false,
		figure,
		decimals,
		disputer: ZERO,
		ruled: false,
		ruledAt: 0n,
		reason: "",
	});
}

indexer.onEvent(
	{ contract: "OptimisticResolver", event: "FigureProposed" },
	async ({ event, context }) => {
		const { params } = event;
		await propose(
			context,
			params.eventId,
			params.proposer,
			event.block.timestamp,
			false,
			params.figure,
			Number(params.decimals),
		);
	},
);

indexer.onEvent(
	{ contract: "OptimisticResolver", event: "InvalidProposed" },
	async ({ event, context }) => {
		await propose(
			context,
			event.params.eventId,
			event.params.proposer,
			event.block.timestamp,
			true,
			0n,
			0,
		);
	},
);

indexer.onEvent(
	{ contract: "OptimisticResolver", event: "Disputed" },
	async ({ event, context }) => {
		const { eventId, disputer } = event.params;
		const round = Number(event.params.round);
		const proposal = await proposalOf(context, eventId, round);
		context.Proposal.set({ ...proposal, disputer: key(disputer) });
		const resolution = await resolutionOf(context, eventId);
		// A first dispute reopens the event for a second proposal; a second sends it to the arbiter.
		context.Resolution.set(
			round === 0
				? { ...resolution, round: 1 }
				: { ...resolution, pendingArbitration: true },
		);
	},
);

indexer.onEvent(
	{ contract: "OptimisticResolver", event: "ProposalSettled" },
	async ({ event, context }) => {
		const resolution = await resolutionOf(context, event.params.eventId);
		const proposal = await proposalOf(
			context,
			event.params.eventId,
			resolution.round,
		);
		context.Proposal.set({ ...proposal, settled: true });
	},
);

// The arbiter's ruling of the outcome settles the second round and closes it; the contest ruled with
// it arrives as its own event.
indexer.onEvent(
	{ contract: "OptimisticResolver", event: "OutcomeRuled" },
	async ({ event, context }) => {
		const resolution = await resolutionOf(context, event.params.eventId);
		context.Resolution.set({
			...resolution,
			pendingArbitration: false,
			outcomeReason: event.params.reason,
		});
		const second = await proposalOf(context, event.params.eventId, 1);
		context.Proposal.set({ ...second, settled: true });
	},
);

indexer.onEvent(
	{ contract: "OptimisticResolver", event: "ContestRuled" },
	async ({ event, context }) => {
		const round = Number(event.params.round);
		const proposal = await proposalOf(context, event.params.eventId, round);
		context.Proposal.set({
			...proposal,
			ruled: true,
			ruledAt: BigInt(event.block.timestamp),
			// The first round's contest keeps its reason; the second's is the event's outcome reason.
			reason: round === 0 ? event.params.reason : proposal.reason,
		});
	},
);

indexer.onEvent(
	{ contract: "OptimisticResolver", event: "ContestReleased" },
	async ({ event, context }) => {
		const first = await proposalOf(context, event.params.eventId, 0);
		context.Proposal.set({
			...first,
			ruled: true,
			ruledAt: BigInt(event.block.timestamp),
		});
	},
);

indexer.onEvent(
	{ contract: "OptimisticResolver", event: "Expired" },
	async ({ event, context }) => {
		const resolution = await resolutionOf(context, event.params.eventId);
		if (event.params.arbiterSilent) {
			// The arbiter never ruled the second round: it closes as settled and ruled, with no reason.
			context.Resolution.set({ ...resolution, pendingArbitration: false });
			const second = await proposalOf(context, event.params.eventId, 1);
			context.Proposal.set({
				...second,
				settled: true,
				ruled: true,
				ruledAt: BigInt(event.block.timestamp),
			});
			return;
		}
		// Nobody proposed in the open round: it closes, empty, as settled.
		const id = proposalId(event.params.eventId, resolution.round);
		const open = await context.Proposal.get(id);
		context.Proposal.set({
			...(open ?? {
				id,
				resolution: event.params.eventId,
				round: resolution.round,
				proposer: ZERO,
				proposedAt: 0n,
				invalid: false,
				figure: 0n,
				decimals: 0,
				disputer: ZERO,
				ruled: false,
				ruledAt: 0n,
				reason: "",
			}),
			settled: true,
		});
	},
);

indexer.onEvent(
	{ contract: "OptimisticResolver", event: "Withdrawn" },
	async ({ event, context }) => {
		context.Withdrawal.set({
			id: logId(event),
			account: key(event.params.account),
			amount: event.params.amount,
		});
	},
);
