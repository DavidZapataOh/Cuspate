"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { TESTNET } from "../chain/record.ts";
import { EmailSessionProvider } from "./EmailSession.tsx";

/**
 * The wallet connection and the chain reads every page shares, through one endpoint. Wallets are
 * the ones the browser announces; none is bundled. Signing in with an email is offered where the
 * deployment names its sign-in app.
 */
export function WalletProviders({
	rpcUrl,
	signInApp,
	children,
}: {
	rpcUrl: string;
	signInApp: string | undefined;
	children: ReactNode;
}) {
	const [config] = useState(() =>
		createConfig({
			chains: [TESTNET],
			transports: { [TESTNET.id]: http(rpcUrl) },
			connectors: [],
			ssr: true,
		}),
	);
	const [queries] = useState(() => new QueryClient());
	return (
		<WagmiProvider config={config}>
			<QueryClientProvider client={queries}>
				<EmailSessionProvider appId={signInApp}>
					{children}
				</EmailSessionProvider>
			</QueryClientProvider>
		</WagmiProvider>
	);
}
