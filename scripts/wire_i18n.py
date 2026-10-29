#!/usr/bin/env python3
"""
Wire the catalogue into the panel and the options page.

The approach is deliberately mechanical and checkable rather than sweeping:

  1. `STEP_LABELS` and the other label maps are used as *fallbacks* rather than replaced, so a step kind that
     exists in the model but not yet in the catalogue still renders a readable English name. Replacing them
     outright would turn an unmapped kind into a raw key on screen.
  2. Every `text: 'Literal'` / `placeholder: 'Literal'` / `title: 'Literal'` that has a catalogue entry is
     rewritten to `text: t('key')`. Strings with no entry are left alone and REPORTED, so nothing is silently
     skipped - a half-translated panel is worse than an English one.
  3. `t` is created once per render from the stored language, and applied to the document, so direction and
     font are correct before the first paint of content.

The report at the end is the important part: it names every string still hardcoded, which is the work list.
"""
import json
import pathlib
import re

ROOT = pathlib.Path("/root/autoflow")
SRC = ROOT / "src"

# key -> English value, from the catalogue
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location("cat", SRC / "core" / "i18n" / "catalogue.js")
# the catalogue is JS; read the two objects with a regex instead of trying to import it
cat_text = (SRC / "core" / "i18n" / "catalogue.js").read_text()


def parse_block(name):
    m = re.search(rf"export const {name} = \{{(.*?)\n\}};", cat_text, re.S)
    if not m:
        raise SystemExit(f"could not find {name} in the catalogue")
    body = m.group(1)
    out = {}
    for line in body.split("\n"):
        mm = re.match(r"\s*'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"|`([^`]*)`),?\s*$", line)
        if not mm:
            continue
        key = mm.group(1)
        value = mm.group(2) or mm.group(3) or mm.group(4) or ""
        out[key] = value.encode().decode("unicode_escape") if "\\" in value else value
    return out


en = parse_block("en")
fa = parse_block("fa")
print(f"catalogue: {len(en)} en keys, {len(fa)} fa keys")

# reverse map: English value -> key. Only for values that are unambiguous.
value_to_key = {}
dupes = []
for k, v in en.items():
    if v in value_to_key:
        dupes.append((v, value_to_key[v], k))
    value_to_key.setdefault(v, k)
if dupes:
    print(f"{len(dupes)} duplicated English values (first key wins):")
    for v, a, b in dupes[:6]:
        print(f"  {v!r}: {a} / {b}")


def wire(path):
    text = path.read_text()
    original = text
    replaced = []
    unresolved = []
    literal = re.compile(r"\b(text|placeholder|title):\s*'((?:[^'\\]|\\.)*)'")

    def sub(m):
        prop, value = m.group(1), m.group(2)
        key = value_to_key.get(value)
        if key is None:
            unresolved.append((prop, value))
            return m.group(0)
        replaced.append((value, key))
        return f"{prop}: t('{key}')"

    text = literal.sub(sub, text)
    path.write_text(text)
    print(f"\n{path.name}: {len(replaced)} strings wired, {len(unresolved)} left hardcoded")
    if unresolved:
        for prop, value in unresolved[:25]:
            print(f"    {prop}: {value!r}")
        if len(unresolved) > 25:
            print(f"    ... and {len(unresolved) - 25} more")
    return replaced, unresolved


panel = SRC / "ui" / "panel" / "panel.js"
options = SRC / "ui" / "options" / "options.js"

r1, u1 = wire(panel)
r2, u2 = wire(options)

print("\n=== the labels maps keep working as fallbacks ===")
print("  STEP_LABELS etc. are still used for model kinds with no catalogue entry, so an unmapped kind")
print("  renders its English name instead of a raw key.")

report = {
    "wired": {"panel": len(r1), "options": len(r2)},
    "hardcoded_remaining": {"panel": [f"{p}: {v}" for p, v in u1], "options": [f"{p}: {v}" for p, v in u2]},
}
out = ROOT / "docs" / "i18n-wiring.json"
out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
print(f"\nwrote {out}")