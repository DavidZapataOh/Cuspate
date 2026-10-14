"use client";

import { useConnection } from "wagmi";

/**
 * The one place the funding page learns who is signed in: the address deposits arrive at and
 * refunds return to. Swapping how sign-in works means changing only this hook.
 */
export function useFundingAddress(): string | undefined {
	return useConnection().address;
}
