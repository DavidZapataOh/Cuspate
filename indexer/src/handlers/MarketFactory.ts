import { indexer } from "envio";
import { conditionOf, key, legsOf } from "../ids";

// The vaults, and the legs each creates, are indexed from the moment their market exists.
indexer.contractRegister(
	{ contract: "MarketFactory", event: "MarketCreated" },
	async ({ event, context }) => {
		for (const vault of [
			event.params.underlyingVault,
			event.params.dollarVault,
		]) {
			context.chain.PositionVault.add(vault);
			const legs = legsOf(vault);
			context.chain.PositionToken.add(legs.yes as `0x${string}`);
			context.chain.PositionToken.add(legs.no as `0x${string}`);
		}
	},
);

indexer.onEvent(
	{ contract: "MarketFactory", event: "MarketCreated" },
	async ({ event, context }) => {
		const { params } = event;
		context.Market.set({
			id: params.marketId,
			eventId: params.eventId,
			resolver: key(params.resolver),
			condition: conditionOf(params.resolver, params.eventId),
			underlying: key(params.underlying),
			dollar: key(params.dollar),
			underlyingVault: key(params.underlyingVault),
			dollarVault: key(params.dollarVault),
		});
		const vaults = [
			[params.underlyingVault, params.underlying, params.underlyingCap],
			[params.dollarVault, params.dollar, params.dollarCap],
		] as const;
		for (const [vault, collateral, cap] of vaults) {
			const legs = legsOf(vault);
			context.Vault.set({
				id: key(vault),
				market: params.marketId,
				collateral: key(collateral),
				cap,
				...legs,
			});
			context.Leg.set({
				id: legs.yes,
				vault: key(vault),
				yes: true,
				supply: 0n,
			});
			context.Leg.set({
				id: legs.no,
				vault: key(vault),
				yes: false,
				supply: 0n,
			});
		}
	},
);

indexer.onEvent(
	{ contract: "MarketFactory", event: "OutcomeReported" },
	async ({ event, context }) => {
		const { params } = event;
		context.Condition.set({
			id: params.condition,
			resolver: key(params.resolver),
			eventId: params.eventId,
			outcome: Number(params.outcome),
		});
	},
);
