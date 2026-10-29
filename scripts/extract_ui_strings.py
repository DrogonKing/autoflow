#!/usr/bin/env python3
"""
Extract every UI string the panel and options page render, with its location.

Why a tool rather than a grep: the strings are not in one shape. They are `text:` props, select options, button
labels, placeholders, confirmation messages, hints, and a few template literals. A grep for `text:` misses the
options, the messages and the hints - and a translation pass that misses 20% of the strings leaves a panel that
is half Persian, which is worse to read than one that is entirely English.

This lists them so the catalogue can be complete before any code changes, and so a test can assert that the
catalogue covers them.
"""
import pathlib
import re
import json

SRC = pathlib.Path("/root/autoflow/src")

# every shape a user-visible string takes in these files
PATTERNS = [
    ("text-prop", re.compile(r"\btext:\s*'((?:[^'\\]|\\.)*)'")),
    ("text-prop-tmpl", re.compile(r"\btext:\s*`([^`]*)`")),
    ("option-text", re.compile(r"\btext:\s*'((?:[^'\\]|\\.)*)'\s*,\s*selected")),
    ("placeholder", re.compile(r"\bplaceholder:\s*'((?:[^'\\]|\\.)*)'")),
    ("title-attr", re.compile(r"\btitle:\s*'((?:[^'\\]|\\.)*)'")),
    ("heading", re.compile(r"el\('h[1-3]',\s*\{\s*text:\s*'((?:[^'\\]|\\.)*)'")),
    ("toast", re.compile(r"toast\(\s*'((?:[^'\\]|\\.)*)'")),
    ("toast-tmpl", re.compile(r"toast\(\s*`([^`]*)`")),
    ("confirm", re.compile(r"(?:confirm|alert)\(\s*'((?:[^'\\]|\\.)*)'")),
    ("label-text", re.compile(r"el\('label',\s*\{[^}]*text:\s*'((?:[^'\\]|\\.)*)'")),
    ("aria", re.compile(r"aria-label[\"']?:\s*'((?:[^'\\]|\\.)*)'")),
]


def harvest(path):
    text = path.read_text()
    found = []
    for kind, rx in PATTERNS:
        for m in rx.finditer(text):
            value = m.group(1)
            if not value.strip():
                continue
            line = text[:m.start()].count("\n") + 1
            found.append({"kind": kind, "value": value, "line": line})
    # de-duplicate by value, keeping the first location
    seen = {}
    for f in found:
        seen.setdefault(f["value"], f)
    return list(seen.values())


targets = {
    "panel": SRC / "ui" / "panel" / "panel.js",
    "options": SRC / "ui" / "options" / "options.js",
    "banner": SRC / "build-banner.js",
}

report = {}
total = 0
for name, path in targets.items():
    if not path.exists():
        print(f"MISSING {path}")
        continue
    items = harvest(path)
    report[name] = items
    total += len(items)
    print(f"{name:9} {path.name:14} {len(items):3} distinct strings")

print(f"\ntotal distinct: {total}")

# group by kind so the shape is visible
print("\nby kind:")
kinds = {}
for items in report.values():
    for i in items:
        kinds[i["kind"]] = kinds.get(i["kind"], 0) + 1
for k, v in sorted(kinds.items(), key=lambda x: -x[1]):
    print(f"  {k:16} {v}")

# the step labels are the biggest single group and worth seeing in full
print("\nstep and block labels (the largest group):")
labels = [i["value"] for items in report.values() for i in items
          if re.match(r"^[A-Z][a-z]", i["value"]) and len(i["value"]) < 28]
for v in sorted(set(labels)):
    print(f"  {v}")

out = pathlib.Path("/root/autoflow/docs/ui-strings.json")
out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
print(f"\nwrote {out} ({out.stat().st_size} bytes)")
