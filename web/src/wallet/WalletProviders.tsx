"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { TESTNET } from "../chain/record.ts";

/**
 * The wallet connection and the chain reads every page shares, through one endpoint. Wallets are
 * the ones the browser announces; none is bundled.
 */
export function WalletProviders({
	rpcUrl,
	children,
}: {
	rpcUrl: string;
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
			<QueryClientProvider client={queries}>{children}</QueryClientProvider>
		</WagmiProvider>
	);
}
