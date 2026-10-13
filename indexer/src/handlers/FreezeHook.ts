import { indexer } from "envio";

const ZERO = "0x0000000000000000000000000000000000000000";

indexer.onEvent(
	{ contract: "FreezeHook", event: "MarketRegistered" },
	async ({ event, context }) => {
		const { params } = event;
		const pools = [
			[params.yesPool, "yes"],
			[params.noPool, "no"],
			[params.probabilityPool, "probability"],
		] as const;
		for (const [id, kind] of pools) {
			context.Pool.set({
				id,
				market: params.marketId,
				kind,
				freezesAt: params.instant,
				frozenEarly: false,
				initialized: false,
				currency0: ZERO,
				currency1: ZERO,
				sqrtPriceX96: 0n,
				tick: 0,
				liquidity: 0n,
			});
		}
	},
);

indexer.onEvent(
	{ contract: "FreezeHook", event: "FrozenEarly" },
	async ({ event, context }) => {
		const pools = await context.Pool.getWhere({
			market: { _eq: event.params.marketId },
		});
		for (const pool of pools)
			context.Pool.set({
				...pool,
				freezesAt: event.params.instant,
				frozenEarly: true,
			});
	},
);
