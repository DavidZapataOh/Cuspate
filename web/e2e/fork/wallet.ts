/**
 * A test wallet for the browser tests, injected into the page before any of its scripts and
 * announced the way real wallets announce themselves (EIP-6963), so the interface finds it as it
 * would find any wallet. It forwards every request to a local fork, whose node signs for its own
 * funded accounts. It has no batched calls, so the purchase takes the path a wallet without them
 * takes. It exists only here: nothing in the interface's own code names it.
 */
import type { Page } from "@playwright/test";

/** The name the test wallet announces itself by. */
export const TEST_WALLET_NAME = "Fork test wallet";
/** Its reverse-DNS id, which a test reads the production bundle for. */
export const TEST_WALLET_RDNS = "test.fork.wallet";

/** Injects the test wallet for `account`, forwarding to the fork at `rpcUrl`. */
export async function injectTestWallet(
	page: Page,
	rpcUrl: string,
	account: string,
): Promise<void> {
	await page.addInitScript(
		({ rpcUrl, account, name, rdns }) => {
			let id = 0;
			let granted = false;
			const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
			const rpc = async (method: string, params: unknown) => {
				const response = await fetch(rpcUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
				});
				const body = await response.json();
				if (body.error)
					throw Object.assign(new Error(body.error.message), body.error);
				return body.result;
			};
			const provider = {
				async request({
					method,
					params,
				}: {
					method: string;
					params?: unknown;
				}) {
					switch (method) {
						// Like a real wallet, no account is shared until the page asks and is granted.
						case "eth_requestAccounts":
							granted = true;
							return [account];
						case "eth_accounts":
							return granted ? [account] : [];
						case "wallet_switchEthereumChain":
						case "wallet_addEthereumChain":
							return null;
						// As most wallets without batched calls answer: the method does not exist.
						case "wallet_sendCalls":
						case "wallet_getCapabilities":
						case "wallet_getCallsStatus":
							throw Object.assign(
								new Error(
									`The method "${method}" does not exist / is not available.`,
								),
								{ code: -32601 },
							);
						case "wallet_requestPermissions":
							granted = true;
							return [{ parentCapability: "eth_accounts" }];
						case "wallet_revokePermissions":
							granted = false;
							return null;
						default:
							return rpc(method, params ?? []);
					}
				},
				on(event: string, listener: (...args: unknown[]) => void) {
					if (!listeners.has(event)) listeners.set(event, new Set());
					listeners.get(event)?.add(listener);
				},
				removeListener(event: string, listener: (...args: unknown[]) => void) {
					listeners.get(event)?.delete(listener);
				},
			};
			const detail = Object.freeze({
				info: {
					uuid: "00000000-0000-4000-8000-000000000001",
					name,
					icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
					rdns,
				},
				provider,
			});
			const announce = () =>
				window.dispatchEvent(
					new CustomEvent("eip6963:announceProvider", { detail }),
				);
			window.addEventListener("eip6963:requestProvider", announce);
			announce();
		},
		{ rpcUrl, account, name: TEST_WALLET_NAME, rdns: TEST_WALLET_RDNS },
	);
}
