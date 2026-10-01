#!/usr/bin/env bash
# Proves that a fresh clone of HEAD builds and tests with nothing from this shell.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# A clone, not an archive: an archive of HEAD carries a submodule's directory and
# none of its files, and the build would silently fetch what the clone omitted.
git clone --quiet --recurse-submodules "${root}" "${work}/clone"

# PATH and HOME only, and a non-login shell: a login shell re-sources the system
# profile, so a secret exported from the author's own profile would survive.
env -i PATH="${PATH}" HOME="${HOME}" bash -c "
set -euo pipefail
cd '${work}/clone'

pnpm install --frozen-lockfile --reporter=silent

# The compiler is toolchain, like forge itself, and not something a clone provides. A machine's
# first build has to fetch it, which the offline build below refuses to do, so it is fetched here
# by its pin, through a source that needs nothing from the clone.
solc=\$(sed -n 's/^solc = \"\\([0-9.]*\\)\"/\\1/p' contracts/foundry.toml)
mkdir -p '${work}/compiler/src'
printf 'pragma solidity %s;\\ncontract Fetch {}\\n' \"\${solc}\" > '${work}/compiler/src/Fetch.sol'
forge build --root '${work}/compiler' --use \"\${solc}\" > /dev/null

# --offline so anything the clone failed to provide fails loudly.
forge build --root contracts --offline
echo 'BUILT contracts'

pnpm --filter cuspate-web run build
echo 'BUILT web'

# One selection at a time, and deliberately not the fork selection. Measured: a fork cannot be
# created without egress even with a warm cache, because the backend asks the endpoint for its
# chain id before it consults the cache. This gate's claim is about an emptied environment, and
# running everything here would make a met condition depend on the network.
./tools/test.sh unit
./tools/test.sh fuzz
./tools/test.sh invariant
pnpm --filter cuspate-web run test
"
