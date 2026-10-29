#!/usr/bin/env python3
"""
Deep audit: verify what the pattern scan claimed, and find what a pattern cannot see.

A regex said "sender validated: yes" because the parameter existed. That is the difference between a scan
and an audit, and it is exactly the false reassurance that makes a scan dangerous on its own.
"""
import pathlib
import re

SRC = pathlib.Path("/root/autoflow/src")


def show(path, pattern, context=0, label=""):
    text = (SRC / path).read_text()
    lines = text.splitlines()
    hits = []
    for i, line in enumerate(lines, 1):
        if re.search(pattern, line):
            lo = max(0, i - 1 - context)
            hi = min(len(lines), i + context)
            hits.append((i, "\n".join(f"      {n+1}| {lines[n]}" for n in range(lo, hi))))
    print(f"\n{'=' * 78}\n{label or pattern}  ({path})\n{'=' * 78}")
    if not hits:
        print("  no match")
    for i, block in hits:
        print(f"  line {i}:")
        print(block)


# ---------------------------------------------------------------------------------------------
print("A. IS THE `html` PROP OF THE el() HELPER EVER USED?")
print("=" * 78)
ui_files = list((SRC / "ui").rglob("*.js"))
for f in ui_files:
    text = f.read_text()
    for m in re.finditer(r"html\s*:", text):
        line = text[:m.start()].count("\n") + 1
        ctx = text.splitlines()[line - 1].strip()
        print(f"  {f.relative_to(SRC)}:{line}  {ctx[:120]}")
print("  --> if there are no call sites, the prop is dead code and should be deleted")

# ---------------------------------------------------------------------------------------------
print("\n\nB. DOES THE BACKGROUND onMessage ACTUALLY VALIDATE THE SENDER?")
print("=" * 78)
bg = (SRC / "background" / "service-worker.js").read_text()
idx = bg.find("chrome.runtime.onMessage.addListener")
body = bg[idx:idx + 9000]
print("  handler signature line:")
print(f"    {bg[idx:bg.find(chr(10), idx)]}")
print()
if re.search(r"sender\s*\.\s*(id|url|origin|tab)", body):
    print("  --> USES the sender object")
    for m in re.finditer(r".*\bsender\s*\.\s*\w+.*", body):
        print(f"      {m.group(0).strip()[:120]}")
else:
    print("  --> NEVER reads sender.id / sender.url / sender.origin / sender.tab")
    print("      The parameter is declared and unused. This is the common shape of a missing check.")

# ---------------------------------------------------------------------------------------------
print("\n\nC. WHERE DOES PAGE-DERIVED DATA REACH THE UI?")
print("=" * 78)
panel = (SRC / "ui" / "panel" / "panel.js").read_text()
# values that originate from a page: extracted variables, trace entries, error messages, element info
for name in ["value", "message", "error", "name", "text", "summary"]:
    n = len(re.findall(rf"\b{name}\b", panel))
    print(f"  panel.js references `{name}`: {n} time(s)")
print()
print("  How each is rendered:")
for pat, label in [
    (r"text:\s*[a-zA-Z_.]+", "text: (textContent - safe)"),
    (r"el\('div',\s*\{\s*text", "el('div',{text:...}) - safe"),
    (r"\.textContent\s*=", ".textContent = - safe"),
    (r"\.innerHTML\s*=", ".innerHTML = - NOT safe if the value is dynamic"),
]:
    hits = re.findall(pat, panel)
    print(f"    {label}: {len(hits)}")

# ---------------------------------------------------------------------------------------------
print("\n\nD. runScript: WHAT EXECUTES, AND WHAT CAN IT REACH?")
print("=" * 78)
content = (SRC / "content" / "content.js").read_text()
idx = content.find("function runInPage")
print(content[idx:idx + 1400])

# ---------------------------------------------------------------------------------------------
print("\n\nE. DOES IMPORTING AN AUTOMATION ALLOW runScript? (supply-chain question)")
print("=" * 78)
steps = (SRC / "core" / "model" / "steps.js").read_text()
print("  is runScript a recognised step kind?")
print(f"    {'yes' if 'runScript' in steps else 'no'}")
print("  is an imported automation validated against a schema?")
storage = (SRC / "background" / "storage.js").read_text()
imp = storage[storage.find("export async function importAll"):][:1500]
print(imp)