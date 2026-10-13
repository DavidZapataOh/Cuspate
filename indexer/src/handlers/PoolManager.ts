import { indexer } from "envio";
import { key, logId } from "../ids";

// The pool manager is shared by every pool on the chain; only the protocol's own pools, registered
// with the freeze hook before they can be initialized, are kept. Pool ids cannot be filtered at the
// source, since they are learned as markets are created.

indexer.onEvent(
	{ contract: "PoolManager", event: "Initialize" },
	async ({ event, context }) => {
		const pool = await context.Pool.get(event.params.id);
		if (pool === undefined) return;
		context.Pool.set({
			...pool,
			initialized: true,
			currency0: key(event.params.currency0),
			currency1: key(event.params.currency1),
			sqrtPriceX96: event.params.sqrtPriceX96,
			tick: Number(event.params.tick),
		});
	},
);

indexer.onEvent(
	{ contract: "PoolManager", event: "ModifyLiquidity" },
	async ({ event, context }) => {
		const { params } = event;
		const pool = await context.Pool.get(params.id);
		if (pool === undefined) return;
		context.LiquidityChange.set({
			id: logId(event),
			pool: params.id,
			sender: key(params.sender),
			tickLower: Number(params.tickLower),
			tickUpper: Number(params.tickUpper),
			liquidityDelta: params.liquidityDelta,
			salt: params.salt,
		});
		// A position counts toward the pool's active liquidity while the price is inside its range, the
		// lower tick included and the upper excluded, as the pool manager counts it.
		if (
			Number(params.tickLower) <= pool.tick &&
			pool.tick < Number(params.tickUpper)
		) {
			context.Pool.set({
				...pool,
				liquidity: pool.liquidity + params.liquidityDelta,
			});
		}
	},
);

indexer.onEvent(
	{ contract: "PoolManager", event: "Swap" },
	async ({ event, context }) => {
		const { params } = event;
		const pool = await context.Pool.get(params.id);
		if (pool === undefined) return;
		context.Swap.set({
			id: logId(event),
			pool: params.id,
			sender: key(params.sender),
			amount0: params.amount0,
			amount1: params.amount1,
			sqrtPriceX96: params.sqrtPriceX96,
			liquidity: params.liquidity,
			tick: Number(params.tick),
			fee: Number(params.fee),
		});
		context.Pool.set({
			...pool,
			sqrtPriceX96: params.sqrtPriceX96,
			tick: Number(params.tick),
			liquidity: params.liquidity,
		});
	},
);
