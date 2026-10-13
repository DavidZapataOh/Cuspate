/**
 * The watchers: each a pure function over what the chain reports, returning the alerts it raises.
 * Read at a finalized block, since the chain's newest blocks are speculative, and polled with the
 * keeper's steps.
 */
import { MAX_AGE, type Quote } from "./arithmetic.ts";
import { dueFollowUps, type EventView } from "./followups.ts";

/** An alert: critical when funds or the feed are wrong, a warning when something needs a person. */
export type Alert = {
	severity: "critical" | "warning";
	watcher: string;
	subject: string;
	message: string;
};

/** The outcomes a vault can report, as the factory numbers them. */
const UNRESOLVED = 0;
const YES = 1;
const NO = 2;

/**
 * Whether a vault holds what it owes. Before resolution every pair of legs redeems one unit of
 * collateral, so it owes the supply, and the two supplies are equal; after it, it owes what
 * redemption pays: twice the winning leg over two, or half of each when invalid. Each redemption
 * rounds down, so owing the rounded-down total is never stricter than what redemption can pay.
 */
export function solvencyWatcher(v: {
	vault: string;
	balance: bigint;
	yesSupply: bigint;
	noSupply: bigint;
	outcome: number;
}): Alert[] {
	const alerts: Alert[] = [];
	const critical = (message: string) =>
		alerts.push({
			severity: "critical",
			watcher: "solvency",
			subject: v.vault,
			message,
		});
	if (v.outcome === UNRESOLVED) {
		if (v.yesSupply !== v.noSupply)
			critical(
				`the legs' supplies differ: ${v.yesSupply} yes, ${v.noSupply} no`,
			);
		if (v.balance < v.yesSupply)
			critical(`holds ${v.balance} against ${v.yesSupply} owed`);
		return alerts;
	}
	const [yesWeight, noWeight] =
		v.outcome === YES ? [2n, 0n] : v.outcome === NO ? [0n, 2n] : [1n, 1n];
	const owed = (v.yesSupply * yesWeight + v.noSupply * noWeight) / 2n;
	if (v.balance < owed)
		critical(`holds ${v.balance} against ${owed} owed after resolution`);
	return alerts;
}

/** A warning when a vault has a hundredth of its cap or less left: entries will soon be refused. */
export function capWatcher(v: {
	vault: string;
	cap: bigint;
	yesSupply: bigint;
}): Alert[] {
	const room = v.cap - v.yesSupply;
	if (room * 100n > v.cap) return [];
	return [
		{
			severity: "warning",
			watcher: "cap",
			subject: v.vault,
			message: `${room} of ${v.cap} left`,
		},
	];
}

/** The feed while the market is open: a quote that makes no sense is critical, an old one a warning. */
export function oracleWatcher(quote: Quote, now: bigint): Alert[] {
	if (quote.session === 0 || quote.session === 5) return [];
	if (quote.price <= 0n || quote.bid <= 0n || quote.bid > quote.ask) {
		return [
			{
				severity: "critical",
				watcher: "oracle",
				subject: "feed",
				message: `price ${quote.price}, bid ${quote.bid}, ask ${quote.ask} in session ${quote.session}`,
			},
		];
	}
	if (now - quote.publishedAt > MAX_AGE) {
		return [
			{
				severity: "warning",
				watcher: "oracle",
				subject: "feed",
				message: `round published ${now - quote.publishedAt} s ago`,
			},
		];
	}
	return [];
}

/** The instant a follow-up became due. */
function dueSince(
	event: EventView,
	followUp: "settle" | "release" | "expire",
): bigint {
	if (followUp === "release") return event.contestTimeout;
	if (followUp === "settle")
		return event.rounds[event.round].proposedAt + event.liveness;
	return event.pendingArbitration ? event.outcomeTimeout : event.expiresAt + 1n;
}

/**
 * The resolver's clocks: a warning when a follow-up has stayed due longer than `grace`, which means
 * no keeper is taking it, and when the arbiter has a day or less left to rule.
 */
export function clockWatcher(
	eventId: string,
	event: EventView,
	now: bigint,
	grace: bigint,
): Alert[] {
	const alerts: Alert[] = [];
	for (const followUp of dueFollowUps(event, now)) {
		const late = now - dueSince(event, followUp);
		if (late > grace) {
			alerts.push({
				severity: "warning",
				watcher: "clock",
				subject: eventId,
				message: `${followUp} has been due for ${late} s`,
			});
		}
	}
	if (
		event.pendingArbitration &&
		now < event.outcomeTimeout &&
		event.outcomeTimeout - now <= 86_400n
	) {
		alerts.push({
			severity: "warning",
			watcher: "clock",
			subject: eventId,
			message: `the arbiter has ${event.outcomeTimeout - now} s left to rule`,
		});
	}
	return alerts;
}

/** A warning when a market was frozen before its announcement: the guardian brought its freeze forward. */
export function freezeWatcher(m: {
	market: string;
	freezesAt: bigint;
	announcesAt: bigint;
}): Alert[] {
	if (m.freezesAt >= m.announcesAt) return [];
	return [
		{
			severity: "warning",
			watcher: "freeze",
			subject: m.market,
			message: `frozen at ${m.freezesAt}, ${m.announcesAt - m.freezesAt} s early`,
		},
	];
}
