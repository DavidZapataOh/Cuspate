import { indexer } from "envio";
import { balanceId, key } from "../ids";

const ZERO = "0x0000000000000000000000000000000000000000";

// Supplies and balances follow from transfers alone: a mint comes from the zero address, a burn goes
// to it.
indexer.onEvent(
	{ contract: "PositionToken", event: "Transfer" },
	async ({ event, context }) => {
		const leg = key(event.srcAddress);
		const { from, to, value } = event.params;
		const move = async (holder: string, delta: bigint) => {
			const id = balanceId(leg, holder);
			const balance = await context.Balance.getOrCreate({
				id,
				leg,
				holder: key(holder),
				amount: 0n,
			});
			context.Balance.set({ ...balance, amount: balance.amount + delta });
		};
		if (key(from) === ZERO || key(to) === ZERO) {
			const current = await context.Leg.getOrThrow(
				leg,
				`a transfer of ${leg}, which no market created`,
			);
			context.Leg.set({
				...current,
				supply: current.supply + (key(from) === ZERO ? value : -value),
			});
		}
		if (key(from) !== ZERO) await move(from, -value);
		if (key(to) !== ZERO) await move(to, value);
	},
);
