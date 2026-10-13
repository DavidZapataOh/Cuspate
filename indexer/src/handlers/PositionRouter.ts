import { indexer } from "envio";
import { key, logId } from "../ids";

indexer.onEvent(
	{ contract: "PositionRouter", event: "Entered" },
	async ({ event, context }) => {
		const { params } = event;
		context.Entry.set({
			id: logId(event),
			market: params.marketId,
			payer: key(params.payer),
			recipient: key(params.recipient),
			yes: params.yes,
			dollars: params.dollars,
			shares: params.shares,
		});
	},
);

indexer.onEvent(
	{ contract: "PositionRouter", event: "Exited" },
	async ({ event, context }) => {
		const { params } = event;
		context.Exit.set({
			id: logId(event),
			market: params.marketId,
			holder: key(params.holder),
			recipient: key(params.recipient),
			yes: params.order.yes,
			shares: params.order.shares,
			kept: params.order.kept,
			out: params.fill.out,
			levelOut: params.fill.levelOut,
			dollars: params.fill.dollars,
		});
	},
);
