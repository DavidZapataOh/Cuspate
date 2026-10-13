import localFont from "next/font/local";

/**
 * The interface's one family, self-hosted: Schibsted Grotesk, variable weight 400 to 900, licensed
 * under the SIL Open Font License (OFL.txt beside the file). It carries tabular figures, which every
 * price, amount and countdown uses. The framework names the family after this constant.
 */
export const schibstedGrotesk = localFont({
	src: "./SchibstedGrotesk-Variable.woff2",
	weight: "400 900",
	style: "normal",
	display: "swap",
	variable: "--font-schibsted",
	fallback: ["system-ui", "sans-serif"],
});
