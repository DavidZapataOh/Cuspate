"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { type Address, getAddress, isAddress } from "viem";
import { expiryOf, sendCode, verifyCode } from "./email.ts";

/** A signed-in email session: its token and the wallet the server holds for it. */
export type Session = { token: string; address: Address };

type EmailSession = {
	/** Whether email sign-in is configured for this deployment. */
	enabled: boolean;
	session: Session | undefined;
	sendCode(email: string): Promise<void>;
	signIn(email: string, code: string): Promise<void>;
	signOut(): void;
};

const KEY = "cuspate.session";
const Context = createContext<EmailSession | undefined>(undefined);

function stored(): Session | undefined {
	try {
		const raw = sessionStorage.getItem(KEY);
		if (!raw) return undefined;
		const session = JSON.parse(raw) as Session;
		return expiryOf(session.token) > Date.now() + 60_000 ? session : undefined;
	} catch {
		return undefined;
	}
}

async function walletFor(token: string): Promise<Address> {
	const response = await fetch("/api/session", {
		headers: { authorization: `Bearer ${token}` },
	});
	const body = (await response.json().catch(() => ({}))) as {
		address?: string;
		message?: string;
	};
	if (!response.ok || !body.address || !isAddress(body.address))
		throw new Error(body.message ?? "Signing in did not finish. Try again.");
	return getAddress(body.address);
}

/**
 * Email sign-in for every page. The session lives for the browser tab and ends when its token
 * expires; the wallet behind it is created by the server on the first sign-in.
 */
export function EmailSessionProvider({
	appId,
	children,
}: {
	appId: string | undefined;
	children: ReactNode;
}) {
	const [session, setSession] = useState<Session | undefined>();
	useEffect(() => setSession(stored()), []);
	useEffect(() => {
		if (!session) return;
		const left = expiryOf(session.token) - Date.now();
		const timer = setTimeout(() => setSession(undefined), Math.max(left, 0));
		return () => clearTimeout(timer);
	}, [session]);

	const signOut = useCallback(() => {
		try {
			sessionStorage.removeItem(KEY);
		} catch {}
		setSession(undefined);
	}, []);

	const value = useMemo<EmailSession>(
		() => ({
			enabled: Boolean(appId),
			session,
			async sendCode(email) {
				if (!appId) return;
				await sendCode(appId, email);
			},
			async signIn(email, code) {
				if (!appId) return;
				const token = await verifyCode(appId, email, code);
				const next = { token, address: await walletFor(token) };
				try {
					sessionStorage.setItem(KEY, JSON.stringify(next));
				} catch {}
				setSession(next);
			},
			signOut,
		}),
		[appId, session, signOut],
	);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The email session, for any component under the providers. */
export function useEmailSession(): EmailSession {
	const value = useContext(Context);
	if (!value) throw new Error("useEmailSession outside EmailSessionProvider");
	return value;
}
