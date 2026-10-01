#!/usr/bin/env sh
# The one command. With no argument it runs the repository suite and then every selection;
# with one argument it runs that selection alone, which is how a slow selection is scheduled
# separately without a second entry point existing.
#
# A selection is a directory. A filename suffix can drift from the directory it sits in, so
# the directory is the only thing that decides membership.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"

selection_glob() {
	case "$1" in
	unit) echo "test/{unit/*,Toolchain.t.sol}" ;;
	fuzz) echo "test/fuzz/*" ;;
	invariant) echo "test/invariant/*" ;;
	fork) echo "test/fork/*" ;;
	*)
		echo "unknown selection: $1 (expected unit, fuzz, invariant or fork)" >&2
		exit 2
		;;
	esac
}

# Test functions, not reported tests: every invariant function in one contract collapses into
# a single reported test, so printing the reported number would state the confusion this
# harness exists to prevent.
count_functions() {
	# The listing is captured before it is counted so that a listing which failed to compile
	# fails here, rather than printing a selection with no number beside it.
	listing="$(forge test --list --json --match-path "$1")"
	printf '%s' "${listing}" | python3 -c '
import json
import sys

listing = json.load(sys.stdin)
print(sum(len(names) for suites in listing.values() for names in suites.values()))
'
}

run_selection() {
	glob="$(selection_glob "$1")"
	cd "${repo}/contracts"
	count="$(count_functions "${glob}")"
	echo "$1 ${count}"

	mkdir -p cache
	log="cache/test-$1.log"

	# The listing and the run index the project separately, and measured: after a test file is
	# added the listing compiles it while the run decides nothing changed and collects nothing,
	# reported as no tests found with exit zero — and with no filter at all, three of four
	# functions ran and the command succeeded. A forced recompile recovers it. The retry is
	# announced rather than silent, and a second empty collection is a failure: a selection that
	# checks nothing is the one thing this harness exists to refuse.
	status=0
	forge test --match-path "${glob}" > "${log}" 2>&1 || status=$?
	if [ "${status}" -eq 0 ] && grep -q "No tests found" "${log}"; then
		echo "$1: the run collected none of the ${count} functions listed; recompiling" >&2
		status=0
		forge test --force --match-path "${glob}" > "${log}" 2>&1 || status=$?
	fi
	cat "${log}"
	if [ "${status}" -ne 0 ]; then
		exit "${status}"
	fi
	if grep -q "No tests found" "${log}"; then
		echo "$1: the listing found ${count} test functions and the run collected none" >&2
		exit 1
	fi
}

if [ "$#" -gt 1 ]; then
	echo "usage: tools/test.sh [unit|fuzz|invariant|fork]" >&2
	exit 2
fi

if [ "$#" -eq 1 ]; then
	run_selection "$1"
	exit 0
fi

cd "${repo}"
node --test --test-concurrency=1 "test/**/*.test.js"
for selection in unit fuzz invariant fork; do
	run_selection "${selection}"
done
