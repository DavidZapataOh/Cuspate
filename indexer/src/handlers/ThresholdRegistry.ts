import { indexer } from "envio";
import { key } from "../ids";

indexer.onEvent(
	{ contract: "ThresholdRegistry", event: "ThresholdSealed" },
	async ({ event, context }) => {
		const { params } = event;
		context.Seal.set({
			id: params.eventId,
			sealer: key(params.sealer),
			sealBlock: params.sealBlock,
			value: params.threshold.value,
			decimals: Number(params.threshold.decimals),
			announcesAt: params.threshold.announcesAt,
			deadline: params.threshold.deadline,
			terms: params.threshold.terms,
		});
	},
);
