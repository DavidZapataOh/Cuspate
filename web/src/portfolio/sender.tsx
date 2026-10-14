"use client";

/**
 * Who sends the portfolio's calls. The session provides an executor through this context (the email
 * wallet with its gas paid, for instance); without one, a connected wallet signs and pays its own
 * gas. The portfolio needs nothing else from the session.
 */
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { Address } from "viem";
import { useConfig, useConnection } from "wagmi";
import { type Executor, walletExecutor } from "../ticket/executor.ts";

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
	return useMemo(() => {
		if (provided) return provided;
		if (!address) return undefined;
		return { account: address, executor: walletExecutor(config, address) };
	}, [provided, config, address]);
}
