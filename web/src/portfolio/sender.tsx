"use client";

/**
 * Who sends the portfolio's calls: an executor provided through this context, else the email
 * session's wallet with its gas paid, else a connected wallet that signs and pays its own gas. The portfolio needs nothing else from the session.
 */
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { Address } from "viem";
import { useConfig, useConnection } from "wagmi";
import {
	type Executor,
	sponsoredExecutor,
	walletExecutor,
} from "../ticket/executor.ts";
import { useEmailSession } from "../wallet/EmailSession.tsx";

const SenderContext = createContext<
	{ account: Address; executor: Executor } | undefined
>(undefined);

/** Hands the portfolio a session's account and executor. */
export function PositionSenderProvider({
	account,
	executor,
	children,
}: {
	account: Address;
	executor: Executor;
	children: ReactNode;
}) {
	const value = useMemo(() => ({ account, executor }), [account, executor]);
	return (
		<SenderContext.Provider value={value}>{children}</SenderContext.Provider>
	);
}

/** The account signed in and how its calls are sent, or nothing while no one is signed in. */
export function usePositionSender():
	| { account: Address; executor: Executor }
	| undefined {
	const provided = useContext(SenderContext);
	const config = useConfig();
	const { address } = useConnection();
	const { session } = useEmailSession();
	return useMemo(() => {
		if (provided) return provided;
		// An email session sends through the server, gas paid, as the ticket does.
		if (session)
			return {
				account: session.address,
				executor: sponsoredExecutor({ token: async () => session.token }),
			};
		if (!address) return undefined;
		return { account: address, executor: walletExecutor(config, address) };
	}, [provided, session, config, address]);
}
