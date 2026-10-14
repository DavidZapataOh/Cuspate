import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { rpcUrl } from "../src/chain/endpoint.ts";
import { schibstedGrotesk } from "../src/fonts/sans.ts";
import { Footer } from "../src/ui/Footer.tsx";
import { Notice } from "../src/ui/Notice.tsx";
import { TopBar } from "../src/ui/TopBar.tsx";
import "./globals.css";
import { WalletProviders } from "../src/wallet/WalletProviders.tsx";
import styles from "./layout.module.css";

export const metadata: Metadata = {
	title: "Cuspate",
	description:
		"Buy a stock only if a condition is met. If it is not, you get your dollars back.",
};

export const viewport: Viewport = {
	themeColor: "#14110E",
	colorScheme: "dark",
};

// The direction these pages are built to, kept in the served markup so a review can hold the
// build to it.
const DIRECTION = `<!--
THESIS: an earnings event is one object with two worlds; the page shows both worlds adding up to the stock's price, never odds or a bet slip.
OWN-WORLD: obsidian ground, cream text, stone for the other world, amber only for the mark and the one action; one warm grotesque with tabular figures; thin cream line drawings.
STORY: the visitor reads what the next condition is, sees what each world pays and what it costs, and can act or compare every open market.
FIRST VIEWPORT: the next event's sentence, its countdown and announcement time, the balance with both pans and the sum at the fulcrum, the ticket under it.
FORM: the approved homepage and event-page comps, reproduced, then made live.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->`;

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className={schibstedGrotesk.variable}>
			<body>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant comment written here, no input reaches it */}
				<div hidden dangerouslySetInnerHTML={{ __html: DIRECTION }} />
				<WalletProviders
					rpcUrl={rpcUrl()}
					signInApp={process.env.NEXT_PUBLIC_PRIVY_APP_ID}
				>
					<TopBar />
					<div className={styles.notice}>
						<Notice>
							<p>Test network: test dollars and test shares, no real value.</p>
						</Notice>
					</div>
					{children}
					<Footer />
				</WalletProviders>
			</body>
		</html>
	);
}
