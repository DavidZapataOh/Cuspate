#!/usr/bin/env sh
# Runs the resolution workflow end to end: the compiled workflow, run by the CRE simulator, reads a real
# earnings release from EDGAR and delivers its report to a receiver on a local chain, and the outcome is
# read from that chain. It needs a CRE account key (CRE_API_KEY), EDGAR, and the production chain's
# public endpoint for the simulation forwarder's code, so it runs in its own job and not in the gates.
# Without the key it skips on a workstation and fails as not evaluated in CI.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "${repo}"

# The CRE CLI is toolchain no clone provides. Installed by its pinned version and checksum when the
# machine does not already have that version.
CRE_VERSION="1.38.0"
CRE_ARCHIVE_SHA256="76c08aab492a76fc76f05f4948e6eef2157b7dfc58dc52cf411f1eb55793a037"
if ! cre version 2>/dev/null | grep -q "v${CRE_VERSION}"; then
	bin="$(mktemp -d)"
	curl -sSfL -o "${bin}/cre.tgz" \
		"https://github.com/smartcontractkit/cre-cli/releases/download/v${CRE_VERSION}/cre_linux_arm64.tar.gz"
	echo "${CRE_ARCHIVE_SHA256}  ${bin}/cre.tgz" | sha256sum -c - > /dev/null
	tar -xzf "${bin}/cre.tgz" -C "${bin}"
	mv "${bin}/cre_v${CRE_VERSION}_linux_arm64" "${bin}/cre"
	chmod 0755 "${bin}/cre"
	PATH="${bin}:${PATH}"
	export PATH
fi

# The harness deploys the contracts from their build output, and the simulator runs the compiled workflow.
(cd contracts && forge build > /dev/null)
pnpm --filter cuspate-cre run build
pnpm --filter cuspate-cre run e2e
