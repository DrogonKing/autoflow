#!/usr/bin/env python3
"""
Make every script locate the repository from its OWN path rather than a hardcoded one.

WHY THIS MATTERS, and it is not cosmetic:

The scripts were written against `/root/autoflow`, which is where this tree happens to live. The first run of
the CI steps inside a clean clone at a different path printed:

    wrote /root/autoflow/docs/review-packet.md

...from a script running in /tmp/clean-clone. Three consequences, in increasing severity:

  1. In CI the file lands outside the checkout. `check_exhibit_completeness.py` then reads a stale packet from
     a different tree and reports on code that is not the code under test.
  2. `check_exhibit_completeness.py` would PASS by reading `/root/autoflow/docs/review-packet.md` - the packet
     built from the developer's working copy - while the CI checkout contains something else. A green check
     that does not test the tree it is running in is worse than no check.
  3. Anyone who clones the repository to any other path gets a tool that writes into a directory they may not
     own, or silently reports on someone else's files.

The fix is a single `ROOT` derived from `__file__`, and every path built from it. `SRC` is asserted to exist so
a wrong root fails loudly rather than producing an empty scan.

This was found by cloning the repo and running the CI job in the clone - which is the only way to find it. The
tests in the developer's own tree could never have caught it.
"""
import pathlib
import re

SCRIPTS = pathlib.Path("/root/autoflow/scripts")

TARGETS = {
    "build_review_packet.py": (
        '''SRC = pathlib.Path("/root/autoflow/src")
OUT = pathlib.Path("/root/autoflow/docs/review-packet.md")''',
        '''# The repository root, derived from THIS file's location so the script works from any checkout path.
# `__file__` is scripts/<name>.py, so the parent of its parent is the tree.
ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if not SRC.is_dir():
    raise SystemExit(f"no src/ next to {ROOT} - the script is not inside a repository checkout")
OUT = ROOT / "docs" / "review-packet.md"
OUT.parent.mkdir(parents=True, exist_ok=True)''',
    ),
    "adversarial_review.py": (
        'SRC = pathlib.Path("/root/autoflow/src")',
        '''# Derived from this file's location, so the audit works from any checkout path rather than only from the
# one directory it was written in.
ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if not SRC.is_dir():
    raise SystemExit(f"no src/ next to {ROOT} - the script is not inside a repository checkout")''',
    ),
    "firefox_security_audit.py": (
        'ROOT = pathlib.Path("/root/autoflow")',
        '''# Derived from this file's location, so the audit works from any checkout path.
ROOT = pathlib.Path(__file__).resolve().parent.parent
if not (ROOT / "src").is_dir():
    raise SystemExit(f"no src/ next to {ROOT} - the script is not inside a repository checkout")''',
    ),
    "follow_the_lead.py": (
        'SRC = pathlib.Path("/root/autoflow/src")',
        '''# Derived from this file's location, so the audit works from any checkout path.
ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if not SRC.is_dir():
    raise SystemExit(f"no src/ next to {ROOT} - the script is not inside a repository checkout")''',
    ),
    "check_exhibit_completeness.py": (
        'ROOT = pathlib.Path("/root/autoflow")',
        '''# Derived from this file's location. This one matters most: a hardcoded root would make the check read a
# packet from a DIFFERENT tree than the one under test, and pass on code it never looked at.
ROOT = pathlib.Path(__file__).resolve().parent.parent
if not (ROOT / "src").is_dir():
    raise SystemExit(f"no src/ next to {ROOT} - the script is not inside a repository checkout")''',
    ),
}

changed = []
for name, (old, new) in TARGETS.items():
    p = SCRIPTS / name
    text = p.read_text()
    if old not in text:
        # already ported?
        if "pathlib.Path(__file__).resolve().parent.parent" in text:
            print(f"  already portable: {name}")
            continue
        raise SystemExit(f"{name}: the hardcoded block was not found")
    p.write_text(text.replace(old, new, 1))
    changed.append(name)

# any remaining absolute reference to the old path in a script
print("\nscanning for any surviving absolute path in scripts/:")
leftovers = []
for p in sorted(SCRIPTS.glob("*.py")):
    for i, line in enumerate(p.read_text().split("\n"), 1):
        if re.search(r'["\']/root/autoflow', line):
            leftovers.append((p.name, i, line.strip()[:90]))
if leftovers:
    for n, i, l in leftovers:
        print(f"  {n}:{i}  {l}")
else:
    print("  none - every script is path-independent")

for c in changed:
    print(f"ported: {c}")