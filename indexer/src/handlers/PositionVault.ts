import { indexer } from "envio";
import { key, logId } from "../ids";

indexer.onEvent(
	{ contract: "PositionVault", event: "PositionSplit" },
	async ({ event, context }) => {
		context.Conversion.set({
			id: logId(event),
			vault: key(event.srcAddress),
			stakeholder: key(event.params.stakeholder),
			merge: false,
			amount: event.params.amount,
		});
	},
);

indexer.onEvent(
	{ contract: "PositionVault", event: "PositionsMerge" },
	async ({ event, context }) => {
		context.Conversion.set({
			id: logId(event),
			vault: key(event.srcAddress),
			stakeholder: key(event.params.stakeholder),
			merge: true,
			amount: event.params.amount,
		});
	},
);

indexer.onEvent(
	{ contract: "PositionVault", event: "PayoutRedemption" },
	async ({ event, context }) => {
		context.Redemption.set({
			id: logId(event),
			vault: key(event.srcAddress),
			redeemer: key(event.params.redeemer),
			yesAmount: event.params.yesAmount,
			noAmount: event.params.noAmount,
		});
	},
);
