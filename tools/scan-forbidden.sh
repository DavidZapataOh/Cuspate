#!/usr/bin/env sh
# Refuses to let certain text reach a public commit.
#
# Two classes, because they differ in secrecy. The clear-text class is published
# here: none of it names anything private. The hashed class is salted, with the salt
# held outside this repository, so the file discloses nothing. Without the salt the
# hashed class cannot run; the scanner says so and passes it, which is correct for a
# fork, since a fork holds none of the terms it could leak.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
hashes="${SCAN_HASHES:-${root}/tools/forbidden.sha256}"

if [ "$#" -gt 0 ]; then
	printf "%s\n" "$@" > /tmp/.scan-targets.$$
else
	git -C "${root}" ls-files > /tmp/.scan-targets.$$
fi
trap 'rm -f /tmp/.scan-targets.$$' EXIT

ROOT="${root}" HASHES="${hashes}" TARGETS="/tmp/.scan-targets.$$" python3 - <<'PYEOF'
import hashlib
import hmac
import json
import os
import pathlib
import re
import sys
import unicodedata

root = pathlib.Path(os.environ["ROOT"]).resolve()
salt = os.environ.get("SCAN_SALT", "")
hashes_path = pathlib.Path(os.environ["HASHES"])
targets = pathlib.Path(os.environ["TARGETS"]).read_text().split()

# Safe to publish: "this repository is English" is already stated in its own working
# rules, and a rule against making a claim is editorial discipline, not disclosure.
# A non-ASCII *letter* indicates text that is not English. Non-ASCII punctuation
# is typography, and flagging it would reject this repository's own prose.
INVERTED = re.compile(r"[\u00bf\u00a1]")
HOME_PATH = re.compile(r"/(?:home|Users)/[A-Za-z0-9._-]+/")
CLAIMS = re.compile(r"new primitive|impossible offchain|new AMM|SEC exemption", re.IGNORECASE)  # scan-allow: this line defines the rule
RELATIVE = re.compile(r"""(?:from|import|require)\s*\(?\s*["']([^"']*\.\./[^"']*)["']""")
# A line may exempt itself from the clear-text classes, which are editorial: the file
# that defines a rule necessarily contains what the rule forbids. The exemption is
# visible in the diff, like any lint suppression. It deliberately does not reach the
# hashed class, which is the one that protects what must not be published.
ALLOW = re.compile(r"scan-allow:")
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._@-]*")

digests = set()
if salt and hashes_path.exists():
    digests = {line.strip() for line in hashes_path.read_text().splitlines() if line.strip()}

def segments(path, text):
    """The stretches of a file that are scanned, one line-numbered block at a time.

    A build output such as a verification input carries its real content inside escaped
    JSON strings. Tokenising the raw file reads a term that follows an escape as part of
    one longer word and lets it through, so such a file is decoded first.
    """
    if path.suffix != ".json":
        return [text]
    try:
        data = json.loads(text)
    except ValueError:
        return [text]
    found = []

    def walk(node):
        if isinstance(node, str):
            found.append(node)
        elif isinstance(node, dict):
            for key, value in node.items():
                found.append(key)
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data)
    return found


findings = []

for target in targets:
    path = pathlib.Path(target)
    if not path.is_absolute():
        path = root / path
    if not path.is_file():
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        continue

    shown = target
    lines = []
    for block in segments(path, text):
        lines.extend(enumerate(block.splitlines(), start=1))
    for number, line in lines:
        if not ALLOW.search(line):
            if INVERTED.search(line) or any(
                ord(ch) > 127 and unicodedata.category(ch).startswith("L") for ch in line
            ):
                findings.append(f"{shown}:{number} non-English text in a tracked file")
            if HOME_PATH.search(line):
                findings.append(f"{shown}:{number} absolute path under a home directory")
            if CLAIMS.search(line):
                findings.append(f"{shown}:{number} refused public claim")
            for match in RELATIVE.finditer(line):
                resolved = (path.parent / match.group(1)).resolve()
                if root not in resolved.parents and resolved != root:
                    findings.append(f"{shown}:{number} relative path escapes the repository root")
        if digests:
            for token in TOKEN.finditer(line):
                digest = hmac.new(salt.encode(), token.group(0).lower().encode(), hashlib.sha256)
                if digest.hexdigest() in digests:
                    # Never the matched text: a public repository's logs are public.
                    findings.append(f"{shown}:{number} forbidden token")

for finding in findings:
    print(finding)

if not salt:
    print("scan ran partially: no salt available, so the hashed class was not evaluated")
elif not hashes_path.exists():
    print("scan ran partially: no hash list found, so the hashed class was not evaluated")

sys.exit(1 if findings else 0)
PYEOF
