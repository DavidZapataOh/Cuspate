/**
 * Makes one role's Safe act: its single owner sends the Safe's own transaction with a pre-validated
 * signature, the way the rehearsal's gate sealed an event and ruled a figure. The keystore is the
 * owner's own: the keeper's Safe is owned by the keeper's key, the others by the deployer's.
 *
 *   DEPLOY_NETWORK=monad_testnet OWNER_KEYSTORE=... OWNER_PASSWORD_FILE=... \
 *     node ops/src/safe-exec.ts <role> <to> <calldata>
 */
import type { Address, Hex } from "viem";
import { committedPath, readBook } from "./book.ts";
import { send } from "./chain.ts";
import { ROLES, type Role } from "./plan.ts";
import { type Alias, NETWORKS } from "./runbook.ts";
import { execData } from "./safe.ts";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

const [role, to, data] = process.argv.slice(2) as [Role, Address, Hex];
if (!ROLES.includes(role) || !to || !data) {
	console.error(`usage: safe-exec.ts <${ROLES.join("|")}> <to> <calldata>`);
	process.exit(2);
}
const network = NETWORKS[required("DEPLOY_NETWORK") as Alias];
if (!network || network.rehearsal)
	throw new Error("safe-exec acts on a network, not a rehearsal");
const safe = readBook(committedPath(network.chainId)).roles?.[role];
if (!safe)
	throw new Error(`no ${role} Safe is recorded for chain ${network.chainId}`);
const owner = safe.owners[0] as Address;
const sent = send(
	network.url(),
	owner,
	{
		kind: "keystore",
		keystore: required("OWNER_KEYSTORE"),
		passwordFile: required("OWNER_PASSWORD_FILE"),
	},
	safe.address,
	execData(to, data, owner),
);
console.error(`${role} acted in ${sent.txHash}`);
