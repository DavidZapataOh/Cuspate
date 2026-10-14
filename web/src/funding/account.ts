"use client";

import { useConnection } from "wagmi";
import { useEmailSession } from "../wallet/EmailSession.tsx";

/**
 * The one place the funding page learns who is signed in: the address deposits arrive at and
 * refunds return to: an email session's wallet, else the connected wallet.
 */
export function useFundingAddress(): string | undefined {
	const { address } = useConnection();
	const { session } = useEmailSession();
	return session?.address ?? address;
}
