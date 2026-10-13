#!/usr/bin/env sh
# Proves the keeper on a fork of the production chain: its arithmetic against the reference keeper's
# vectors, its corrections into the band, its follow-ups against the resolver, and that it never acts
# twice across a restart, two instances and a stolen key nonce. It needs the chain's archive endpoint,
# as the fork selection does, so it runs in its own job and not in the gates.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "${repo}"

# The fork harness deploys the protocol from the contracts' build output.
(cd contracts && forge build > /dev/null)
pnpm --filter cuspate-keeper run build
pnpm --filter cuspate-keeper run test
