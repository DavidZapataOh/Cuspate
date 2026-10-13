#!/usr/bin/env sh
# Rehearses the protocol's deployment on forks of both networks, each followed by its end-to-end gate:
# the test network with its test contracts and the production chain with its manifest's placeholders.
# It reads both networks' public endpoints, so it runs in its own job and not in the gates. It never
# broadcasts: a rehearsal sends only to the local node it starts.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "${repo}"

pnpm --filter cuspate-ops run build
pnpm --filter cuspate-ops run test
DEPLOY_NETWORK=testnet_rehearsal tools/deploy.sh protocol
DEPLOY_NETWORK=mainnet_rehearsal tools/deploy.sh protocol
