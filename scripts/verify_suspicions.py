#!/usr/bin/env python3
"""
Verify four specific suspicions before fixing anything.

1. Is `upload` a step we advertise but never implement?
2. Is `contextMenus` permission used at all?
3. Are `stop` / `break` / `continue` handled somewhere?
4. Which permissions are actually referenced in code?
"""
import pathlib
import re

SRC = pathlib.Path("/root/autoflow/src")
CORE = SRC / "core"

steps_js = (CORE / "model" / "steps.js").read_text()
runner = (CORE / "engine" / "runner.js").read_text()
content = (SRC / "content" / "content.js").read_text()

# --- 1. every declared step kind, and where it is handled
declared = re.search(r"export const STEP_KINDS = \[([\s\S]*?)\]", steps_js)
kinds = re.findall(r"'([a-zA-Z]+)'", declared.group(1)) if declared else []
print("=" * 78)
print("1. DECLARED STEP KINDS vs WHERE THEY ARE HANDLED")
print("=" * 78)
print(f"  declared in the UI: {len(kinds)}")
print()
print(f"  {'kind':16} {'runner':9} {'content':9} {'worker':9} verdict")
unhandled = []
for k in kinds:
    in_runner = bool(re.search(rf"case '{k}'", runner)) or bool(re.search(rf"'{k}'", runner))
    in_content = bool(re.search(rf"case '{k}'", content))
    in_worker = bool(re.search(rf"case '{k}'", (SRC / "background" / "service-worker.js").read_text()))
    handled = in_runner or in_content or in_worker
    if not handled:
        unhandled.append(k)
    verdict = "OK" if handled else "*** DECLARED BUT NEVER HANDLED ***"
    print(f"  {k:16} {str(in_runner):9} {str(in_content):9} {str(in_worker):9} {verdict}")
print()
print(f"  unhandled: {unhandled if unhandled else '(none)'}")

# --- 2 & 4. permissions actually used
print()
print("=" * 78)
print("2/4. ARE THE DECLARED PERMISSIONS ACTUALLY USED?")
print("=" * 78)
manifest = (SRC / "manifest.json").read_text()
perms = re.findall(r'"([a-zA-Z]+)"', re.search(r'"permissions": \[([\s\S]*?)\]', manifest).group(1))
allcode = "\n".join(p.read_text() for p in SRC.rglob("*.js"))
print(f"  {'permission':20} {'code references':16} verdict")
for p in perms:
    # the API namespace: webNavigation -> chrome.webNavigation, storage -> chrome.storage
    n = len(re.findall(rf"chrome\.{p}\.", allcode))
    verdict = "used" if n else "*** DECLARED BUT UNUSED ***"
    print(f"  {p:20} {n:<16} {verdict}")

# --- 3. contextMenus specifically
print()
print("  contextMenus in detail:")
hits = [f"{p.relative_to(SRC)}" for p in SRC.rglob("*.js") if "contextMenus" in p.read_text()]
print(f"    files mentioning it: {hits if hits else '(none)'}")

# --- 5. web_accessible_resources actually fetched?
print()
print("=" * 78)
print("3/5. WEB ACCESSIBLE RESOURCES AND SEARCH FOR PAGE-SIDE FETCH")
print("=" * 78)
print("  is picker.css fetched by any page-side code?")
for p in SRC.rglob("*.js"):
    t = p.read_text()
    if "picker.css" in t:
        print(f"    {p.relative_to(SRC)}")
print("  is it linked from an extension page (where it does not need to be web-accessible)?")
for p in SRC.rglob("*.html"):
    if "picker.css" in p.read_text():
        print(f"    {p.relative_to(SRC)} links it")

# --- 6. importAll validation
print()
print("=" * 78)
print("6. WHAT DOES importAll ACCEPT?")
print("=" * 78)
storage = (SRC / "background" / "storage.js").read_text()
print("  checks performed on each imported record:")
for m in re.finditer(r"if \(([^)]*)\)\s*\{\s*throw", storage[storage.find("export async function importAll"):]):
    print(f"    {m.group(1)}")
print("  does it validate steps against the known kinds?",
      "YES" if "STEP_KINDS" in storage else "NO - an imported step kind is not checked")
print("  does it warn about runScript in an imported file?",
      "YES" if "runScript" in storage else "NO - a shared file can contain script steps silently")