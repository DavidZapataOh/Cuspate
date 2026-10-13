/**
 * The interface's colours, one opaque hex per token, so a computed colour can be compared with its
 * token exactly. `app/tokens.css` declares the same values; a test holds the two together.
 *
 * The ground is a warm obsidian and text is cream, never pure white. Amber is the single accent and
 * is reserved for the mark and the primary action. The two outcomes are cream ("if they beat") and
 * stone ("if they don't"): two states of one object, never red and green.
 */
export const palette = {
	bg: "#14110E",
	surface: "#1C1814",
	"surface-2": "#25201A",
	line: "#2F2B27",
	text: "#D1C9BD",
	"text-muted": "#99938A",
	amber: "#C8873F",
	stone: "#A79B8F",
	error: "#D66E55",
} as const;

/** The name of a colour token. */
export type PaletteToken = keyof typeof palette;
