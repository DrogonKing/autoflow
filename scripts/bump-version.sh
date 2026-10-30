#!/usr/bin/env bash
#
# Version bump across every file that carries it.
#
# Why a script rather than an edit: the version lives in FOUR places and they are read by different consumers,
# so a partial bump produces a build whose manifest, package and artifact disagree. That already happened once
# on the sibling AutoClicker project, where a `v1.0.8` tag shipped a 1.0.6 filename.
#
#   package.json                          npm + the source of truth
#   src/manifest.json                     what the browser reads (both builds derive from it)
#   src/ui/options/options.js             the version the user sees on the options page
#   README.md                             the documented version
#
# Usage: scripts/bump-version.sh 1.1.0
set -euo pipefail

NEW="${1:-}"
if [ -z "$NEW" ]; then
  echo "usage: $0 <version>   e.g. $0 1.1.0" >&2
  exit 1
fi
if ! printf '%s' "$NEW" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "not a semver version: $NEW" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

OLD="$(python3 -c "import json;print(json.load(open('package.json'))['version'])")"
if [ "$OLD" = "$NEW" ]; then
  echo "already at $NEW"
  exit 0
fi

echo "bumping $OLD -> $NEW"

python3 - "$OLD" "$NEW" <<'PY'
import json
import pathlib
import sys

old, new = sys.argv[1], sys.argv[2]
changed = []

# package.json - the source of truth
p = pathlib.Path("package.json")
d = json.loads(p.read_text())
d["version"] = new
p.write_text(json.dumps(d, indent=2) + "\n")
changed.append("package.json")

# the manifest, which BOTH builds derive from
p = pathlib.Path("src/manifest.json")
d = json.loads(p.read_text())
d["version"] = new
p.write_text(json.dumps(d, indent=2) + "\n")
changed.append("src/manifest.json")

# the options page shows it to the user; it reads the manifest, so this is only a fallback string
for rel in ("src/ui/options/options.js",):
    p = pathlib.Path(rel)
    t = p.read_text()
    if old in t:
        p.write_text(t.replace(old, new))
        changed.append(rel)

# README: only the version strings, and only if it names the old one
p = pathlib.Path("README.md")
if p.exists():
    t = p.read_text()
    if old in t:
        p.write_text(t.replace(old, new))
        changed.append("README.md")

for c in changed:
    print(f"  updated {c}")
PY

echo "done: $NEW"
echo "next: git tag v$NEW   (and push, which triggers the release workflow)"
