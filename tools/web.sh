#!/usr/bin/env sh
# Proves the interface in the three browser engines Playwright ships: every primitive renders, the
# computed colours are the tokens, the accessibility engine finds nothing, reduced motion moves
# nothing, and each engine's render matches its committed reference. Browsers are toolchain no clean
# clone provides, so this runs in its own job and never in the gates or the clean clone.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "${repo}"

# On a fresh runner the engines and the system libraries they need are installed here; where they
# are already present this only confirms it.
if [ "${CI:-}" = "true" ]; then
	pnpm --filter cuspate-web exec playwright install --with-deps chromium firefox webkit
else
	pnpm --filter cuspate-web exec playwright install chromium firefox webkit
fi
pnpm --filter cuspate-web run build
pnpm --filter cuspate-web run test:browser
