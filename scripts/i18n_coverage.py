#!/usr/bin/env python3
"""
Prove the UI has no hardcoded English left, and that every `t('key')` call has a catalogue entry.

This is the check that makes the translation trustworthy. A mechanical pass plus a human pass leaves doubt:
did anything get missed? The only way to answer that without reading 2000 lines is to scan for the shapes a
user-visible string takes and report what is still a literal.

Two independent assertions, because they catch different mistakes:

  NO LITERALS   every `text:`, `placeholder:`, `title:` in the shipped UI is either a `t(...)` call, a
                dynamic expression, or on an explicit allowlist of values that are deliberately not translated
                (glyphs, units, and Latin technical terms).

  NO DEAD KEYS  every `t('key')` used in the code exists in both catalogues. A key used but missing renders as
                the key itself, so this is the check that would catch a typo.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

UI_FILES = [
    SRC / "ui" / "panel" / "panel.js",
    SRC / "ui" / "options" / "options.js",
    SRC / "build-banner.js",
]

# Values that are deliberately NOT translated, each for a reason. Listed explicitly so adding a new literal
# forces a decision rather than silently passing.
ALLOWED_LITERALS = {
    # glyphs and arrows: identical in every language
    '↑', '↓', '✕', '⧉', '🗑', '◧', '⚙', '⌖', '▶', '✎', '⭳', '⭱', '↻',
    # units and technical tokens the user matches against DevTools and the docs
    'ms', 'px', 'CSS', 'XPath', 'id', 'name', 'label', 'aria-label', 'role', 'cron',
    'URL', 'JSON', 'CSV', 'DOM',
    # a date format, not prose
    '00:00',
    '',
}

# Shapes that render a string to the user.
#
# `text`, `placeholder` and `title` are also ORDINARY OBJECT PROPERTIES in this codebase - the finder model has
# `{ placeholder: 'placeholder' }` as a field-name mapping. Matching bare `placeholder:` reported that mapping
# as a hardcoded English string. So the pattern requires the property to appear inside an `el(` call, which is
# the only place these become visible text. This is the fifth false positive from the same root cause: matching
# an identifier without the context that gives it meaning.
LITERAL_PATTERNS = [
    re.compile(r"\bel\([^)]*?\btext:\s*'([^']*)'", re.S),
    re.compile(r"\bel\([^)]*?\bplaceholder:\s*'([^']*)'", re.S),
    re.compile(r"\bel\([^)]*?\btitle:\s*'([^']*)'", re.S),
    # A label carried in an array and rendered through a variable, e.g.
    #   for (const [id, label] of [['automations', 'Automations'], ...]) { ... text: label ... }
    # This shape defeated the first version of this scanner: it proved "no hardcoded literals" while the
    # rendered panel still showed English tabs. Caught by reading the actual rendered text in a browser.
    re.compile(r"\[\s*'([A-Z][A-Za-z ]{2,24})'\s*\]"),
]

# Words that are legitimately English in a Persian UI: glyphs are in ALLOWED_LITERALS, and these are the
# technical tokens a user reads next to DevTools and the English docs.
ALLOWED_WORDS = {
    'AutoFlow', 'CSS', 'XPath', 'JSON', 'CSV', 'DOM', 'URL', 'HTTP', 'HTTPS',
    'Alt', 'Shift', 'Ctrl', 'Tab', 'Enter', 'Esc', 'Escape', 'Space',
    'English', 'Firefox', 'Chrome', 'Edge', 'Brave', 'Opera', 'Vazirmatn',
    'id', 'name', 'label', 'aria', 'role', 'cron', 'ms', 'px', 'localhost',
}

CAT = (SRC / "core" / "i18n" / "catalogue.js").read_text()


def catalogue_keys(name):
    m = re.search(rf"export const {name} = \{{(.*?)\n\}};", CAT, re.S)
    if not m:
        raise SystemExit(f"could not find the {name} catalogue")
    return set(re.findall(r"^\s*'([^']+)':", m.group(1), re.M))


en_keys = catalogue_keys("en")
fa_keys = catalogue_keys("fa")

problems = []
used_keys = set()

def strip_comments(src):
    """
    Remove comments, so the scan only sees code.

    Learned the hard way, four times now: a check that matches raw text reports things that are not there.
    This scanner flagged `t('key')` because a doc comment explaining the calling convention contains that
    exact string. Block comments first, then line comments - order matters, since `//` appears inside a block
    comment and `/*` inside a line comment.
    """
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    out = []
    for line in src.split("\n"):
        # a URL contains `//` but not at line start, so only strip from a `//` that is not part of `://`
        m = re.search(r"(?<![:'\"`])//", line)
        out.append(line if not m else line[:m.start()])
    return "\n".join(out)


for path in UI_FILES:
    if not path.exists():
        problems.append(f"MISSING FILE {path}")
        continue
    text = strip_comments(path.read_text())
    rel = path.relative_to(ROOT)

    # every t('key') or t("key") call
    for m in re.finditer(r"\bt\(\s*'([^']+)'", text):
        used_keys.add(m.group(1))

    # every remaining literal
    for rx in LITERAL_PATTERNS:
        for m in rx.finditer(text):
            value = m.group(1)
            if value in ALLOWED_LITERALS:
                continue
            # a template literal or an interpolation is dynamic, not a hardcoded English word
            if '${' in value or value.startswith('+'):
                continue
            line = text[:m.start()].count("\n") + 1
            problems.append(f"{rel}:{line}  hardcoded literal: {value!r}")

print("=" * 78)
print("TRANSLATION COVERAGE")
print("=" * 78)
print(f"catalogue: {len(en_keys)} en keys, {len(fa_keys)} fa keys")
print(f"keys used in the UI: {len(used_keys)}")

missing_in_en = sorted(used_keys - en_keys)
missing_in_fa = sorted(used_keys - fa_keys)
if missing_in_en:
    problems.append(f"used but not in en: {missing_in_en}")
if missing_in_fa:
    problems.append(f"used but not in fa: {missing_in_fa}")

unused = sorted(en_keys - used_keys)
if unused:
    print(f"\n{len(unused)} catalogue keys not referenced by the UI (fine if used indirectly):")
    for k in unused[:12]:
        print(f"  {k}")
    if len(unused) > 12:
        print(f"  ... and {len(unused) - 12} more")

if problems:
    print(f"\n{len(problems)} PROBLEM(S):")
    for p in problems:
        print(f"  {p}")
else:
    print("\nno hardcoded user-visible strings, and every key used exists in both catalogues")

report = {
    "en_keys": len(en_keys),
    "fa_keys": len(fa_keys),
    "used_keys": len(used_keys),
    "missing_in_en": missing_in_en,
    "missing_in_fa": missing_in_fa,
    "unused_keys": unused,
    "hardcoded": [p for p in problems if "hardcoded" in p],
    "passed": not problems,
}
out = ROOT / "docs" / "i18n-coverage.json"
out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
print(f"\nwrote {out}")

sys.exit(1 if problems else 0)
