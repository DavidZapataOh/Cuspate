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

# Counts what the listing says will run: test functions, for the reader, and suites, for the
# comparison below. Functions rather than reported tests, because every invariant function in one
# contract collapses into one reported test. And abstract suites are left out — measured, the
# listing includes them although they have no bytecode and never run.
count_listing() {
	# Captured before it is counted, so a listing that failed to compile fails here.
	listing="$(forge test --list --json --match-path "$1")"
	printf '%s' "${listing}" | python3 -c '
import json
import pathlib
import sys

listing = json.load(sys.stdin)
functions = suites = 0
for file, found in listing.items():
    for suite, names in found.items():
        artefact = pathlib.Path("out") / pathlib.Path(file).name / f"{suite}.json"
        # Skipped only when the artefact says so. A missing artefact or field is counted, which
        # keeps the comparison strict rather than letting it shrink.
        code = json.loads(artefact.read_text()).get("bytecode", {}).get("object") if artefact.exists() else None
        if code in ("", "0x"):
            continue
        functions += len(names)
        suites += 1
print(functions, suites)
'
}

suites_run() {
	ran="$(sed -n 's/^Ran \([0-9][0-9]*\) test suites\{0,1\} in.*/\1/p' "$1" | tail -1)"
	echo "${ran:-0}"
}

run_selection() {
	glob="$(selection_glob "$1")"
	cd "${repo}/contracts"
	listed="$(count_listing "${glob}")"
	count="${listed% *}"
	suites="${listed#* }"
	echo "$1 ${count}"

	mkdir -p cache
	log="cache/test-$1.log"

	# The listing and the run index the project separately, and measured twice: right after a
	# test file is added the run can collect nothing while the listing sees everything, and it can
	# collect some suites and silently drop others — three of four functions ran once, four of
	# twelve another time, and both runs exited zero. A forced recompile recovers it. So the
	# suites the run reports are compared with the suites listed; a shortfall is announced and
	# retried once, and a second shortfall is a failure, because a selection that checked part of
	# itself and said nothing is the failure this harness exists to refuse.
	status=0
	forge test --match-path "${glob}" > "${log}" 2>&1 || status=$?
	if [ "${status}" -eq 0 ] && [ "$(suites_run "${log}")" -lt "${suites}" ]; then
		echo "$1: the run collected $(suites_run "${log}") of ${suites} suites listed; recompiling" >&2
		status=0
		forge test --force --match-path "${glob}" > "${log}" 2>&1 || status=$?
	elif [ "${status}" -ne 0 ] && grep -q "no bytecode for contract" "${log}"; then
		# The same cache, failing the other way: a suite is collected while a contract it deploys
		# still has no current bytecode, and its setup fails although nothing is wrong with the code.
		# Only that signature is retried; any other failure stands as it is.
		echo "$1: a deployed contract had no current bytecode; recompiling" >&2
		status=0
		forge test --force --match-path "${glob}" > "${log}" 2>&1 || status=$?
	fi
	cat "${log}"
	if [ "${status}" -ne 0 ]; then
		exit "${status}"
	fi
	if [ "$(suites_run "${log}")" -lt "${suites}" ]; then
		echo "$1: the listing found ${suites} suites and the run collected $(suites_run "${log}")" >&2
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
