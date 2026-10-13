#!/usr/bin/env python3
# Drops abstract suites from a test listing, reading the fact from each suite's source.
#
# Reads the JSON that `forge test --list --json` prints on stdin and prints it back without the
# suites declared `abstract contract`. The listing includes abstract bases, which never run, so
# every comparison of what was listed with what ran must leave them out. Reading that from the
# build artefacts proved fragile: right after files change, an abstract base's artefact can be
# missing when the listing is counted, and a missing artefact has to count to keep the
# comparison strict. Whether a contract is abstract is a fact of its source, so it is read there.
# A file that cannot be read keeps its suites, for the same strictness.
#
# Paths in the listing are relative to the working directory, as forge prints them.
import json
import re
import sys

COMMENTS = re.compile(r"//[^\n]*|/\*.*?\*/", re.DOTALL)


def abstract_in(source, suite):
    """Whether `source` declares `suite` as an abstract contract, comments ignored."""
    code = COMMENTS.sub("", source)
    return re.search(r"\babstract\s+contract\s+" + re.escape(suite) + r"\b", code) is not None


def runnable(listing):
    """The listing without its abstract suites."""
    kept = {}
    for file, suites in listing.items():
        try:
            with open(file, encoding="utf-8") as handle:
                source = handle.read()
        except OSError:
            kept[file] = suites
            continue
        kept[file] = {suite: names for suite, names in suites.items() if not abstract_in(source, suite)}
    return kept


if __name__ == "__main__":
    json.dump(runnable(json.load(sys.stdin)), sys.stdout)
