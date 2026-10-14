import { type IssuerProfile, issuer as profileOf } from "cuspate-shared";

/** What naming needs of an event (its ticker; the rest is the issuer's shared profile) and of a condition. */
type Issuer = { issuer: string };
type Threshold = { threshold: bigint; decimals: number; primary: boolean };

/** A threshold in dollars, keeping exactly its sealed decimals: "$0.43", "$39.40". */
export function formatThreshold({ threshold, decimals }: Threshold): string {
	const negative = threshold < 0n;
	const digits = (negative ? -threshold : threshold)
		.toString()
		.padStart(decimals + 1, "0");
	const whole = digits.slice(0, digits.length - decimals);
	const fraction = decimals > 0 ? `.${digits.slice(-decimals)}` : "";
	return `${negative ? "-" : ""}$${whole}${fraction}`;
}

/**
 * Whether a condition may be called beating expectations: only the primary condition (sealed at the
 * consensus) of an issuer whose published figure is the one the consensus uses. An issuer that
 * publishes only GAAP EPS is compared by the market with figures it does not publish, so its
 * conditions always name the figure instead.
 */
function beats(event: Issuer, condition: Threshold): boolean {
	return (
		condition.primary &&
		profileOf(event.issuer).figureKind === "non-gaap-diluted-eps"
	);
}

function figure(event: Issuer): string {
	return profileOf(event.issuer).figureKind === "non-gaap-diluted-eps"
		? "adjusted EPS"
		: "EPS";
}

function company(event: Issuer): IssuerProfile["shortName"] {
	return profileOf(event.issuer).shortName;
}

function capitalised(words: string): string {
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The condition's name in a list: "Beats expectations ($0.43 adjusted EPS)", "EPS above $6.39". */
export function conditionTitle(issuer: Issuer, condition: Threshold): string {
	const value = formatThreshold(condition);
	return beats(issuer, condition)
		? `Beats expectations (${value} ${figure(issuer)})`
		: `${capitalised(figure(issuer))} above ${value}`;
}

/** The condition as a sentence about buying: the headline of the featured event. */
export function headline(issuer: Issuer, condition: Threshold): string {
	return beats(issuer, condition)
		? `Buy ${company(issuer)} only if they beat expectations.`
		: `Buy ${company(issuer)} only if ${figure(issuer)} is above ${formatThreshold(condition)}.`;
}

/** The two pans of the balance: the world where the condition holds, then the other. */
export function panLabels(
	issuer: Issuer,
	condition: Threshold,
): [string, string] {
	return beats(issuer, condition)
		? ["If they beat", "If they don't"]
		: [`If it's above ${formatThreshold(condition)}`, "If not"];
}

/**
 * The words on a condition's actions: the ticket's button, which buys the world chosen, the quiet
 * link to the other world, and a row's two short choices.
 */
export function buttonWords(issuer: Issuer, condition: Threshold, yes = true) {
	const value = formatThreshold(condition);
	const [holds, fails] = beats(issuer, condition)
		? [
				{ buy: "Buy if they beat", other: "or if they beat" },
				{ buy: "Buy if they don't", other: "or if they don't" },
			]
		: [
				{ buy: `Buy if above ${value}`, other: `or if above ${value}` },
				{ buy: "Buy if not", other: "or if not" },
			];
	const short = beats(issuer, condition)
		? { yesShort: "If they beat", noShort: "If they don't" }
		: { yesShort: "If above", noShort: "If not" };
	return yes
		? { buy: holds.buy, other: fails.other, ...short }
		: { buy: fails.buy, other: holds.other, ...short };
}
