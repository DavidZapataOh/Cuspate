#!/usr/bin/env sh
# Builds, rehearses, deploys and records exactly one contract.
#
# This is the only thing that writes contracts/deployments/<chainid>.json, and it writes
# only after a receipt exists, from the receipt. Nothing is recorded on the strength of a
# simulation: a simulated write produces a complete, real-looking entry for an address
# that has no code, and two of the fields cannot be correct from inside a script at all.
#
# Usage: tools/deploy.sh [--broadcast]
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
factory="0x4e59b44847b379578588920cA78FbF26c0B4956C"
key="Probe"

broadcast=0
if [ "${1:-}" = "--broadcast" ]; then
	broadcast=1
elif [ "$#" -gt 0 ]; then
	echo "usage: tools/deploy.sh [--broadcast]" >&2
	exit 2
fi

# Preflight. Every variable is named with the tier it belongs to, so a missing one is
# reported rather than discovered half way through a deploy.
require_var() {
	eval "value=\${$1:-}"
	if [ -z "$value" ]; then
		echo "missing $1 ($2 tier)" >&2
		exit 1
	fi
}

require_var DEPLOY_NETWORK read
case "${DEPLOY_NETWORK}" in
local)
	require_var LOCAL_RPC_URL read
	named_chain=31337
	;;
monad_testnet)
	require_var MONAD_TESTNET_RPC_URL read
	named_chain=10143
	;;
monad)
	require_var MONAD_RPC_URL read
	named_chain=143
	;;
monad_archive)
	require_var MONAD_ARCHIVE_RPC_URL read
	named_chain=143
	;;
*)
	echo "unknown network alias: ${DEPLOY_NETWORK}" >&2
	exit 1
	;;
esac
if [ "${broadcast}" -eq 1 ]; then
	require_var DEPLOY_SENDER broadcast
	require_var DEPLOY_SIGNER broadcast
	# A keystore needs its password from a file, not from a prompt: the signing path the
	# irreversible run uses has to be the same one a rehearsal can exercise, and a prompt
	# makes that impossible. The password is never a variable; its location is.
	if [ "${DEPLOY_SIGNER}" = "keystore" ]; then
		require_var DEPLOY_KEYSTORE broadcast
		require_var DEPLOY_PASSWORD_FILE broadcast
	fi
fi

cd "${repo}/contracts"
rpc="${DEPLOY_NETWORK}"

forge build >&2

# The chain decides which file is written. Nothing else is allowed to.
chain_id="$(cast chain-id --rpc-url "${rpc}")"

# The one check that catches an environment pointing somewhere other than where its
# author believes, before anything is spent. It costs a single free read.
if [ "${chain_id}" != "${named_chain}" ]; then
	echo "refusing: alias ${DEPLOY_NETWORK} names chain ${named_chain}, its endpoint reports ${chain_id}" >&2
	exit 1
fi

case "${chain_id}" in
31337 | 10143) ;;
*)
	echo "refusing to run against chain ${chain_id}: this pipeline is local and rehearsal only" >&2
	exit 1
	;;
esac

salt="${PROBE_SALT:-$(cast keccak "cuspate.probe.v1")}"
init_code="$(jq -r '.bytecode.object' "out/DeployProbe.s.sol/${key}.json")"
predicted="$(cast create2 --salt "${salt}" --init-code "${init_code}" | cut -f1)"

# The duplicate guard asks the chain, which is the truthful question: a guard that read
# the record would be wedged by any rehearsal and by any failed broadcast.
if [ "$(cast code "${predicted}" --rpc-url "${rpc}")" != "0x" ]; then
	echo "refusing: code already exists at ${predicted}" >&2
	exit 1
fi

# The rehearsal recomputes the address with the cheatcode and fails if it disagrees.
# Its composed entry goes outside version control, and the cheatcode will not create the
# directory it writes into.
mkdir -p deployments/.rehearsal
PROBE_SALT="${salt}" forge script DeployProbe --rpc-url "${rpc}" >&2

# Two independent computations of the same address: the cheatcode's, recorded by the
# rehearsal, and this wrapper's. A disagreement means one of them is wrong, and which one
# is not worth guessing at before a broadcast.
rehearsed="$(jq -r '.address' "deployments/.rehearsal/${chain_id}.json")"
if [ "$(printf '%s' "${rehearsed}" | tr 'A-Z' 'a-z')" != "$(printf '%s' "${predicted}" | tr 'A-Z' 'a-z')" ]; then
	echo "refusing: the rehearsal computed ${rehearsed} and this wrapper predicted ${predicted}" >&2
	exit 1
fi

# Verification is bytecode equality plus an HTTP call, and the submission cannot be
# withdrawn. The input is produced and scanned on every run, rehearsal included, so the
# step is never first exercised on the one run that is irreversible.
mkdir -p cache/verification
input="cache/verification/${key}.json"
forge verify-contract --show-standard-json-input \
	"${predicted}" "script/DeployProbe.s.sol:${key}" > "${input}"

publishing=0
if [ "${broadcast}" -eq 1 ] && [ "${chain_id}" != 31337 ]; then
	publishing=1
	# Without the salt the scanner passes its hashed class by design, which is right for a
	# fork and wrong here: that class holds every term that must not be published.
	require_var SCAN_SALT publish
fi

if ! scan_report="$("${repo}/tools/scan-forbidden.sh" "${input}")"; then
	echo "${scan_report}" >&2
	echo "refusing: the verification input carries something that must not be published" >&2
	exit 1
fi
echo "${scan_report}" >&2
case "${scan_report}" in
*"ran partially"*)
	if [ "${publishing}" -eq 1 ]; then
		echo "refusing: the scanner skipped its hashed class, which is the one that matters here" >&2
		exit 1
	fi
	;;
esac

if [ "${broadcast}" -eq 0 ]; then
	echo "rehearsed ${key} at ${predicted}; nothing was sent" >&2
	exit 0
fi

data="${salt}$(printf '%s' "${init_code}" | sed 's/^0x//')"
case "${DEPLOY_SIGNER}" in
unlocked) signer="--unlocked" ;;
keystore) signer="--keystore ${DEPLOY_KEYSTORE} --password-file ${DEPLOY_PASSWORD_FILE}" ;;
*)
	echo "unknown signer: ${DEPLOY_SIGNER} (expected unlocked or keystore)" >&2
	exit 1
	;;
esac

# Gas is charged on the limit, so the limit is the measured estimate and not a round
# number. An over-generous limit is an unrecoverable overpayment on this network.
gas_limit="$(cast estimate --from "${DEPLOY_SENDER}" --rpc-url "${rpc}" "${factory}" "${data}")"

# shellcheck disable=SC2086
receipt="$(cast send --json --gas-limit "${gas_limit}" --from "${DEPLOY_SENDER}" ${signer} \
	--rpc-url "${rpc}" "${factory}" "${data}")"

tx_hash="$(printf '%s' "${receipt}" | jq -r '.transactionHash')"
block="$(printf '%s' "${receipt}" | jq -r '.blockNumber' | xargs cast to-dec)"
deployed="$(printf '%s' "${receipt}" | jq -r '.logs[0].address // empty')"
if [ -z "${deployed}" ]; then
	deployed="${predicted}"
fi
commit="$(git -C "${repo}" rev-parse HEAD)"

book="deployments/${chain_id}.json"
mkdir -p deployments
if [ ! -f "${book}" ]; then
	echo '{}' > "${book}"
fi
jq -S --indent 2 \
	--arg key "${key}" --arg address "${predicted}" --arg factory "${factory}" \
	--arg salt "${salt}" --arg txHash "${tx_hash}" --arg commit "${commit}" \
	--argjson block "${block}" \
	'.[$key] = {address: $address, factory: $factory, salt: $salt, constructorArgs: "0x", block: $block, txHash: $txHash, commit: $commit}' \
	"${book}" > "${book}.tmp"
mv "${book}.tmp" "${book}"

echo "recorded ${key} at ${predicted} in contracts/${book}" >&2

# One invocation broadcasts and submits, so an unverified contract cannot silently ship.
# Sourcify is the backend that needs no key, which is what keeps this half of the
# pipeline free of secrets.
if [ "${publishing}" -eq 1 ]; then
	forge verify-contract --verifier sourcify --rpc-url "${rpc}" \
		"${predicted}" "script/DeployProbe.s.sol:${key}" >&2
fi
