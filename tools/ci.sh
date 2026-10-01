#!/usr/bin/env bash
# Every gate this repository enforces, runnable locally exactly as the pipeline runs it.
#
# With one argument it runs that gate or command alone, which is what each pipeline step does: a
# gate that existed only inside the workflow could be observed only by pushing. With no argument
# it reports the tripwires first and then runs every gate, continuing past a red one so that all
# of them are seen.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${repo}/node_modules/.bin:${PATH}"
cd "${repo}"

# Measured: the test runner marks its child processes, and a runner started inside one then
# reports in a serialised form meant for its parent rather than by name. This script is itself run
# from the suite, so without this a gate's report would carry no readable test name.
unset NODE_TEST_CONTEXT

# The gate set, machine-readable on purpose: the suite compares it, pairwise, with the workflow's
# steps and with the fixtures that prove each gate can go red.
GATES=(clean-clone repository-suite build format lint documentation licences selections size gas coverage)

# Commands that are not gates: a report, and the one job that holds a secret.
COMMANDS=(tripwires forbidden-terms)

# First-party contracts the Solidity analyser cannot reach, none of them protocol code. The
# analyser inspects contracts/src only and cannot be told otherwise, so a contract anywhere else is
# either named here by a decision or a tripwire fails. This list may only shrink.
NOT_PROTOCOL=(contracts/script/AddressBook.sol contracts/script/DeployProbe.s.sol contracts/test/helpers/Ledger.sol contracts/test/invariant/LedgerHandler.sol)

UNIT_GLOB="test/{unit/*,Toolchain.t.sol}"
FLOOR_FILE="contracts/coverage-floor.txt"
BASELINE_FILE="contracts/.gas-snapshot"

# Every report line names where its number came from. Several tools print nothing on success, so
# for those the number is what this script found, which is not evidence of what the tool read.
counted() {
	printf '%s: %s %s inspected (counted by the %s)\n' "$1" "$2" "$3" "$4"
}

unarmed() {
	printf '%s: unarmed: %s\n' "$1" "$2"
}

first_party_solidity() {
	find contracts -name '*.sol' \
		-not -path 'contracts/lib/*' -not -path 'contracts/out/*' \
		-not -path 'contracts/cache/*' -not -path 'contracts/broadcast/*' | sort
}

checked_by_biome() {
	sed -n 's/^Checked \([0-9][0-9]*\) files.*/\1/p' "$1" | tail -1
}

gate_clean_clone() {
	local log
	log="$(mktemp)"
	"${repo}/tools/clean-clone.sh" 2>&1 | tee "${log}"
	counted clean-clone "$(grep -c '^BUILT ' "${log}")" workspaces script
}

gate_repository_suite() {
	local log files=()
	log="$(mktemp)"
	while IFS= read -r file; do
		files+=("${file}")
	done < <(find test -name '*.test.js' -not -path test/ci.test.js | sort)
	# This pipeline's own reconciliation runs last and alone, so a failure in it cannot be masked
	# by the suite it is reconciling.
	node --test --test-concurrency=1 "${files[@]}" 2>&1 | tee "${log}"
	if [ -f test/ci.test.js ]; then
		node --test test/ci.test.js 2>&1 | tee -a "${log}"
	fi
	# Matched by shape rather than by the runner's leading symbol, which is outside ASCII.
	counted repository-suite "$(awk 'NF == 3 && $2 == "tests" && $3 ~ /^[0-9]+$/ {sum += $3} END {print sum + 0}' "${log}")" tests tool
}

gate_build() {
	forge build --root contracts
	if [ -d web ]; then
		pnpm --filter cuspate-web run build
	fi
	counted build "$(first_party_solidity | wc -l)" "Solidity files" script
}

gate_format() {
	local log
	log="$(mktemp)"
	forge fmt --check --root contracts
	biome format --colors=off . 2>&1 | tee "${log}"
	counted format "$(first_party_solidity | wc -l)" "Solidity files" script
	counted format "$(checked_by_biome "${log}")" "other files" tool
}

gate_lint() {
	local log sources
	log="$(mktemp)"
	# Guarded rather than piped from a failing search: under pipefail a search over a missing
	# directory aborts the gate with no output at all, which is a gate failing silently.
	sources=0
	if [ -d contracts/src ]; then
		sources="$(find contracts/src -name '*.sol' | wc -l)"
	fi
	# The deny flag is the gate. Measured: without it the analyser prints its findings and exits
	# zero.
	forge lint --root contracts -D warnings
	biome lint --colors=off --error-on-warnings . 2>&1 | tee "${log}"
	if [ "${sources}" -eq 0 ]; then
		unarmed lint "the Solidity analyser inspects contracts/src only, and it holds no file"
	else
		counted lint "${sources}" "Solidity files under contracts/src" script
	fi
	counted lint "$(checked_by_biome "${log}")" "other files" tool
}

gate_documentation() {
	local log status=0
	log="$(mktemp)"
	solhint --config contracts/.solhint.json \
		"contracts/test/**/*.sol" "contracts/script/**/*.sol" "contracts/src/**/*.sol" \
		> "${log}" 2>&1 || status=$?
	# The tool prints advertising on a run with findings, and the pipeline's log is public.
	grep -vE '===>|[│┌┐└┘─]' "${log}" || true
	if [ "${status}" -ne 0 ]; then
		return "${status}"
	fi
	counted documentation "$(first_party_solidity | wc -l)" "Solidity files" script
}

gate_licences() {
	node --test test/licence-headers.test.js
	counted licences "$(first_party_solidity | wc -l)" "Solidity files" script
}

gate_selections() {
	local log
	log="$(mktemp)"
	# The fork selection is not here: it needs an endpoint this job does not depend on, and it
	# runs in a job of its own.
	for selection in unit fuzz invariant; do
		"${repo}/tools/test.sh" "${selection}" 2>&1 | tee -a "${log}"
	done
	counted selections "$(awk '/^(unit|fuzz|invariant) [0-9]+$/ {sum += $2} END {print sum + 0}' "${log}")" "test functions" tool
}

gate_size() {
	local report status=0
	report="$(mktemp)"
	# The flag is the gate, not the ceiling. Measured: a build without it exits zero against a
	# contract several times over the limit, and the same build with it exits one.
	forge build --root contracts --sizes --json > "${report}" 2> "${report}.errors" || status=$?
	cat "${report}.errors" >&2
	# The margins are read so each contract's headroom is reported, which at this ceiling is the
	# gate's only regular product; a negative one is named whichever limit it breaks.
	python3 - "${report}" "${status}" <<'PY'
import json
import pathlib
import sys

text, status = pathlib.Path(sys.argv[1]).read_text().strip(), int(sys.argv[2])
try:
    sizes = json.loads(text) if text else {}
except ValueError:
    sizes = {}
over = []
for name, size in sorted(sizes.items()):
    if size["runtime_margin"] < 0:
        over.append(f"size: {name} is {-size['runtime_margin']} bytes over the runtime ceiling")
    if size["init_margin"] < 0:
        over.append(f"size: {name} is {-size['init_margin']} bytes over the creation-code ceiling")
for line in over:
    print(line)
if status != 0 or over:
    sys.exit(status or 1)
tightest = min(sizes.items(), key=lambda item: item[1]["runtime_margin"], default=None)
if tightest:
    print(f"size: least headroom is {tightest[0]}, {tightest[1]['runtime_margin']} bytes under the runtime ceiling")
print(f"size: {len(sizes)} contracts inspected (counted by the tool)")
PY
}

gate_gas() {
	# A baseline is comparable only under one pair of execution settings. Measured, the four
	# combinations of the two swing by about fifty thousand gas, and a comparison across a changed
	# pair is noise — which gets a tolerance widened until the gate cannot fail.
	forge config --root contracts --json | python3 -c '
import json
import sys

config = json.load(sys.stdin)
wanted = {"network": "monad", "isolate": True}
for key, value in wanted.items():
    if config.get(key) != value:
        print(f"gas: refusing to compare: {key} is {config.get(key)!r}, the baseline assumes {value!r}")
        sys.exit(1)
'
	if [ ! -f "${BASELINE_FILE}" ]; then
		unarmed gas "no baseline is committed yet"
		return 0
	fi
	# No tolerance flag. Measured, a tolerance of zero reports a difference between equal values
	# and fails every entry; without the flag the check is plain equality, which on this baseline
	# has been stable across repeated runs and a clean rebuild.
	(cd contracts && forge snapshot --check --match-path "${UNIT_GLOB}")
	counted gas "$(grep -c '(gas: ' "${BASELINE_FILE}")" "baseline entries" script
}

gate_coverage() {
	if [ ! -f "${FLOOR_FILE}" ]; then
		unarmed coverage "no floor is committed yet"
		return 0
	fi
	local report
	report="$(mktemp -d)/lcov.info"
	(cd contracts && forge coverage --no-match-path "test/fork/*" --report lcov --report-file "${report}")
	# The tool has no threshold and no source-path selector, so the floor is computed here from the
	# report's own per-file records, over first-party contracts outside the declared list.
	python3 - "${report}" "$(tr -d '[:space:]' < "${FLOOR_FILE}")" "${NOT_PROTOCOL[@]}" <<'PY'
import pathlib
import sys

report, floor, declared = pathlib.Path(sys.argv[1]), float(sys.argv[2]), set(sys.argv[3:])
records, current = [], None
if report.exists():
    for line in report.read_text().splitlines():
        if line.startswith("SF:"):
            current = {"file": "contracts/" + line[3:], "found": 0, "hit": 0}
        elif line.startswith("LF:") and current:
            current["found"] = int(line[3:])
        elif line.startswith("LH:") and current:
            current["hit"] = int(line[3:])
        elif line == "end_of_record" and current:
            records.append(current)
            current = None

# First-party only. Measured: the report carries the vendored test library's files whenever a test
# imports them, regardless of the setting that claims to leave libraries out, and they dilute the
# total to a number about somebody else's code.
measured = [
    r for r in records
    if not r["file"].startswith("contracts/lib/")
    and r["file"] not in declared
    and not r["file"].endswith(".t.sol")
]
found = sum(r["found"] for r in measured)
# Fail-closed, and distinct: a report holding no record, or records that measure no line, is not a
# pass. On a tree with no source the report is a zero-byte file and the tool exits zero.
if not measured or found == 0:
    print("coverage: no source measured")
    sys.exit(3)
percent = 100 * sum(r["hit"] for r in measured) / found
print(f"coverage: {len(measured)} source files inspected (counted by the tool)")
print(f"coverage: {percent:.2f}% of lines, against a floor of {floor:g}")
if percent < floor:
    print("coverage: below the committed floor")
    sys.exit(1)
PY
}

command_tripwires() {
	node --test --test-name-pattern="^tripwire" test/ci.test.js
}

command_forbidden_terms() {
	if [ -z "${SCAN_SALT:-}" ]; then
		echo "forbidden-terms: not evaluated: no salt is available to this run" >&2
		return 1
	fi
	"${repo}/tools/scan-forbidden.sh"

	# The pushed messages. A message has no path or line worth printing, only the identifier, which
	# resolves to the whole message: so the identifier and the class are all that is reported.
	local range messages status=0 findings
	if [ -z "${SCAN_BASE:-}" ] || [ -z "${SCAN_BASE//0/}" ]; then
		range="${SCAN_HEAD:-HEAD}"
	else
		range="${SCAN_BASE}..${SCAN_HEAD:-HEAD}"
	fi
	messages="$(mktemp -d)"
	git rev-list "${range}" | while IFS= read -r commit; do
		git log --format=%B -n 1 "${commit}" > "${messages}/${commit}"
	done
	if [ -z "$(ls -A "${messages}")" ]; then
		echo "forbidden-terms: the pushed range holds no commit"
		return 0
	fi
	findings="$("${repo}/tools/scan-forbidden.sh" "${messages}"/* 2>&1)" || status=$?
	printf '%s\n' "${findings}" | sed -E "s#^${messages}/([0-9a-f]+):[0-9]+ #\\1 #"
	return "${status}"
}

run_one() {
	case "$1" in
	clean-clone) gate_clean_clone ;;
	repository-suite) gate_repository_suite ;;
	build) gate_build ;;
	format) gate_format ;;
	lint) gate_lint ;;
	documentation) gate_documentation ;;
	licences) gate_licences ;;
	selections) gate_selections ;;
	size) gate_size ;;
	gas) gate_gas ;;
	coverage) gate_coverage ;;
	tripwires) command_tripwires ;;
	forbidden-terms) command_forbidden_terms ;;
	*)
		echo "unknown gate: $1 (expected one of: ${GATES[*]} ${COMMANDS[*]})" >&2
		exit 2
		;;
	esac
}

if [ "$#" -gt 1 ]; then
	echo "usage: tools/ci.sh [gate]" >&2
	exit 2
fi
if [ "$#" -eq 1 ]; then
	run_one "$1"
	exit 0
fi

# The tripwires are reported before any gate. A hygiene gate going red first would otherwise be the
# only thing an author sees; they fix it, see green, and never learn a tripwire was red too.
failed=()
for name in tripwires "${GATES[@]}"; do
	# A separate process for each, so that a failure inside one aborts that one and is recorded,
	# rather than being swallowed by the list this loop builds.
	"${BASH_SOURCE[0]}" "${name}" || failed+=("${name}")
done
if [ "${#failed[@]}" -gt 0 ]; then
	echo "red: ${failed[*]}" >&2
	exit 1
fi
