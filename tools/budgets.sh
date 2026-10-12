#!/usr/bin/env sh
# Compares one group of committed gas budgets with what its suite measures now, by key and by value.
#
# Foundry's own check compares only the keys present on both sides, so a budget that was dropped,
# added or left stale passes it. This measures into an empty scratch directory instead and compares
# the whole file, which needs nothing from Foundry beyond writing what it measured.
#
# Usage: tools/budgets.sh <group> <suite file, relative to contracts/>
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
group="$1"
suite="$2"
committed="${repo}/contracts/snapshots/${group}.json"

if [ ! -f "${committed}" ]; then
	echo "${group}: contracts/snapshots/${group}.json is not committed" >&2
	exit 1
fi

scratch="$(mktemp -d)"
trap 'rm -rf "${scratch}"' EXIT
cd "${repo}/contracts"

measure() {
	FOUNDRY_SNAPSHOTS="${scratch}" FORGE_SNAPSHOT_EMIT=true forge test "$@" --match-path "${suite}" \
		> "${scratch}/log" 2>&1 || {
		cat "${scratch}/log" >&2
		exit 1
	}
}

measure
# The build cache can collect no suite at all right after a file changes, and then nothing is
# written; a forced recompile recovers it.
if [ ! -f "${scratch}/${group}.json" ]; then
	measure --force
fi

python3 - "${committed}" "${scratch}/${group}.json" "${group}" <<'EOF'
import json
import pathlib
import sys

committed_path, measured_path, group = sys.argv[1:]
committed = json.loads(pathlib.Path(committed_path).read_text())
measured_file = pathlib.Path(measured_path)
if not measured_file.exists():
    print(f"{group}: the suite recorded nothing")
    sys.exit(1)
measured = json.loads(measured_file.read_text())

wrong = [f"  changed: {key}: {committed[key]} -> {measured[key]}" for key in sorted(committed.keys() & measured.keys()) if committed[key] != measured[key]]
wrong += [f"  not measured any more: {key}" for key in sorted(committed.keys() - measured.keys())]
wrong += [f"  measured but not committed: {key}" for key in sorted(measured.keys() - committed.keys())]
if wrong:
    print(f"{group}: the measured budgets differ from contracts/snapshots/{group}.json")
    print("\n".join(wrong))
    sys.exit(1)
print(f"{group}: {len(committed)} budgets inspected (counted by the script)")
EOF
