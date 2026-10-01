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

# --offline so anything the clone failed to provide fails loudly.
forge build --root contracts --offline
echo 'BUILT contracts'

pnpm --filter cuspate-web run build
echo 'BUILT web'

forge test --root contracts
pnpm --filter cuspate-web run test
"
