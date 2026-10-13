#!/usr/bin/env sh
# Reconciles the indexer with the chain: a market taken through its whole life on a fork of the
# production chain, indexed, and every entity compared with what the contracts answer. It needs the
# chain's archive endpoint, as the fork selection does, so it runs in its own job and not in the gates.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "${repo}"

# The indexer reads its ABIs, and the fork harness its bytecode, from the contracts' build output.
(cd contracts && forge build > /dev/null)
pnpm --filter cuspate-indexer run build
pnpm --filter cuspate-indexer run test
