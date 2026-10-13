import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { schibstedGrotesk } from "../src/fonts/sans.ts";
import "./globals.css";

export const metadata: Metadata = {
	title: "Cuspate",
	description:
		"Buy a stock only if a condition is met. If it is not, you get your dollars back.",
};

export const viewport: Viewport = {
	themeColor: "#14110E",
	colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className={schibstedGrotesk.variable}>
			<body>{children}</body>
		</html>
	);
}
