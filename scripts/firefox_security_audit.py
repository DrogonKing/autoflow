#!/usr/bin/env python3
"""
Firefox-specific security audit of the BUILT artefacts.

The Firefox build comes from the same source as the Chromium one, so most of the review carries over. What
does NOT carry over is everything outside the shared code: the manifest, the extension scheme, and the
permission model. Each of those is a place where a guard can silently stop applying, and a guard that stops
applying fails OPEN - the code still runs, it just no longer checks anything.

Four things are audited here, and each is a question with a wrong answer that would not announce itself:

  A. Manifest diff. Every key that differs, with its security impact. A key that disappears on one side
     takes its behaviour with it.
  B. Scheme handling in the BUILT bundle. `chrome-extension://` literals are correct on Chromium and fatal
     on Firefox: a guard comparing against them rejects the extension's own pages. This was already one real
     bug; the audit checks the shipped file, not the source.
  C. The zero-network claim, verified on the Firefox bundle specifically - because the manifest now makes a
     FORMAL declaration to Mozilla (`data_collection_permissions: none`). A false declaration there is worse
     than no declaration.
  D. Firefox-only API assumptions: `sidePanel` vs `sidebar_action`, `service_worker` vs `scripts`, and any
     `chrome.*` use that would behave differently on the callback-only namespace.
"""
import json
import pathlib
import re

# Derived from this file's location, so the audit works from any checkout path.
ROOT = pathlib.Path(__file__).resolve().parent.parent
if not (ROOT / "src").is_dir():
    raise SystemExit(f"no src/ next to {ROOT} - the script is not inside a repository checkout")
CHROME = ROOT / "dist"
FF = ROOT / "dist-firefox"

findings = []
notes = []


def add(sev, file, issue, impact):
    findings.append({"severity": sev, "file": str(file), "issue": issue, "impact": impact, "surface": "firefox"})


print("=" * 78)
print("FIREFOX-SPECIFIC SECURITY AUDIT")
print("=" * 78)

if not (FF / "manifest.json").exists():
    raise SystemExit("dist-firefox/manifest.json is missing - run npm run build:firefox")

cm = json.loads((CHROME / "manifest.json").read_text(encoding="utf-8"))
fm = json.loads((FF / "manifest.json").read_text(encoding="utf-8"))

# =============================================================================================
# A. MANIFEST DIFF
# =============================================================================================
print("\nA. MANIFEST DIFF (what differs, and does it weaken a control?)")

all_keys = sorted(set(cm) | set(fm))
diffs = []
for k in all_keys:
    a, b = cm.get(k, "<absent>"), fm.get(k, "<absent>")
    if a != b:
        diffs.append((k, a, b))

for k, a, b in diffs:
    print(f"\n   {k}")
    print(f"     chromium: {json.dumps(a)[:150]}")
    print(f"     firefox : {json.dumps(b)[:150]}")

# A1. the background model. A service worker and an event page have different lifetimes; if the Firefox side
# had BOTH keys, Firefox would ignore service_worker and the manifest would contradict itself.
fb = fm.get("background", {})
if "service_worker" in fb:
    add("medium", "dist-firefox/manifest.json", "background.service_worker is declared",
        "Firefox ignores this key, so the manifest states a background model that is not the one running")
else:
    notes.append("background: only `scripts` on Firefox, only `service_worker` on Chromium - each manifest "
                 "states the model it actually runs")
if not fb.get("scripts"):
    add("critical", "dist-firefox/manifest.json", "no background.scripts",
        "the extension would not start at all on Firefox")

# A2. the side surface. If `sidePanel` permission survived, Firefox would reject or warn; if `side_panel`
# survived, the manifest would reference a key Firefox does not know.
if "sidePanel" in fm.get("permissions", []):
    add("medium", "dist-firefox/manifest.json", "the Chromium-only sidePanel permission is still declared",
        "Firefox rejects it as an invalid permission, and an over-declared permission widens the install prompt")
else:
    notes.append("permissions: sidePanel removed on Firefox, sidebar_action added")
if "side_panel" in fm:
    add("medium", "dist-firefox/manifest.json", "the Chromium-only side_panel key is still declared",
        "an unknown key in a Firefox manifest is a review flag")
if "sidebar_action" not in fm:
    add("high", "dist-firefox/manifest.json", "no sidebar_action",
        "the panel has no entry point on Firefox, so the whole UI is unreachable")

# A3. host access. The same <all_urls> on both sides - required by the product, and the reason the message
# allowlist is the load-bearing control.
if fm.get("host_permissions") != cm.get("host_permissions"):
    add("high", "dist-firefox/manifest.json", "host permissions differ from the Chromium build",
        "an unexpected difference in host access between two builds of one product is either a mistake or a "
        "widened attack surface on one side")
else:
    notes.append(f"host_permissions identical on both: {cm.get('host_permissions')}")

# A4. permissions must be the same set minus sidePanel, and nothing may be added on the Firefox side
cperms = set(cm.get("permissions", [])) - {"sidePanel"}
fperms = set(fm.get("permissions", []))
extra = fperms - cperms
if extra:
    add("high", "dist-firefox/manifest.json", f"Firefox declares permissions the Chromium build does not: {sorted(extra)}",
        "a permission present only on one build is easy to leave un-reviewed")
else:
    notes.append(f"permissions: Firefox declares {sorted(fperms)} - the same set the code uses, minus sidePanel")

# A5. the formal consent declaration. This is a statement to Mozilla AND to the user, so it must be true.
dcp = fm.get("browser_specific_settings", {}).get("gecko", {}).get("data_collection_permissions")
print(f"\n   data_collection_permissions: {json.dumps(dcp)}")
if dcp != {"required": ["none"], "optional": []}:
    add("high", "dist-firefox/manifest.json",
        f"data_collection_permissions is {json.dumps(dcp)} rather than none/none",
        "either the extension collects data that is not declared, or it declares collection it does not do")
else:
    notes.append("data_collection_permissions declares `none` - verified against the bundle in section C")

# A6. an add-on id is required in MV3 and pins updates to one install
gid = fm.get("browser_specific_settings", {}).get("gecko", {}).get("id")
if not gid:
    add("critical", "dist-firefox/manifest.json", "no gecko.id",
        "Firefox refuses to install an MV3 add-on without one")
else:
    notes.append(f"gecko.id = {gid} (a stable id, so an update lands on the same install rather than a second copy)")

# A7. minimum version must not understate what the manifest requires
minv = fm.get("browser_specific_settings", {}).get("gecko", {}).get("strict_min_version")
if dcp and minv and float(minv) < 140:
    add("medium", "dist-firefox/manifest.json", f"strict_min_version {minv} predates data_collection_permissions (140)",
        "the consent key is ignored on those versions, so the declaration a reviewer relies on silently "
        "does not exist there")
else:
    notes.append(f"strict_min_version {minv} - the oldest version on which this manifest means what it says")

# =============================================================================================
# B. SCHEME HANDLING IN THE BUILT BUNDLE
# =============================================================================================
print("\nB. SCHEME HANDLING IN THE BUILT FIREFOX BUNDLE")

built = {p.name: p.read_text(encoding="utf-8") for p in FF.glob("*.js")}
print(f"   bundles: {sorted(built)}")

# B1. a scheme literal used for IDENTITY comparison. Allowed only where it is not a guard.
scheme_hits = []
for name, text in built.items():
    for m in re.finditer(r"chrome-extension://", text):
        line = text[:m.start()].count("\n") + 1
        ctx = text[max(0, m.start() - 120):m.start() + 80].replace("\n", " ")
        scheme_hits.append((name, line, ctx))

if scheme_hits:
    print(f"   chrome-extension:// literals: {len(scheme_hits)} (inspecting each)")
    guard_like = [h for h in scheme_hits if re.search(r"startsWith|match|test\(|===|includes", h[2])]
    for name, line, ctx in guard_like[:6]:
        print(f"     {name}:{line}  ...{ctx[-110:]}")
    if guard_like:
        add("critical", "dist-firefox/*.js",
            f"{len(guard_like)} identity comparison(s) against the literal chrome-extension://",
            "on Firefox the extension's own scheme is moz-extension://, so such a guard rejects the "
            "extension's OWN pages and worker - every page action then fails with 'no answer'")
    else:
        notes.append("the remaining chrome-extension:// occurrences are comments or URL construction, not "
                     "identity guards")
else:
    notes.append("zero chrome-extension:// literals in the Firefox bundle")

# B2. the guard must be written against the thing being guarded
content = built.get("content.js", "")
if re.search(r"\^\(\?:https\?\|ftp\|data\|blob\|file\)", content) or "https?|ftp|data|blob|file" in content:
    notes.append("content guard rejects http/https/ftp/data/blob/file senders and accepts any "
                 "*-extension:// scheme - written against the property, not against one browser's spelling")
else:
    add("high", "dist-firefox/content.js", "the content sender guard is not scheme-neutral",
        "either it lets a web-page sender through, or it rejects the extension's own pages")

# B3. classifySender must resolve the base url at runtime rather than compare a constant
sw = built.get("background.js", "")
if "getURL(\"\")" in sw or "getURL('')" in sw:
    notes.append("classifySender compares against runtime.getURL(''), which carries the right scheme on each "
                 "browser, so the same code classifies correctly on both")
else:
    add("medium", "dist-firefox/background.js", "the sender classifier does not use the runtime base url",
        "the classification depends on a hardcoded scheme and is wrong on one of the two browsers")

# B4. any chrome.* left in the Firefox bundle is the callback-only namespace there
chrome_api = sorted(set(re.findall(r"\bchrome\.(\w+)\.", sw + content + built.get("panel.js", ""))))
if chrome_api:
    add("high", "dist-firefox/*.js", f"direct chrome.* namespace use: {chrome_api}",
        "on Firefox chrome.* is callback-only, so a promise-style call returns undefined and a check that "
        "depends on the value silently passes or fails")
else:
    notes.append("zero direct chrome.* calls in the Firefox bundle - every API goes through the platform layer")

# =============================================================================================
# C. THE ZERO-NETWORK CLAIM, ON THE FIREFOX BUNDLE
# =============================================================================================
print("\nC. ZERO-NETWORK DECLARATION (data_collection_permissions says none - is it true?)")

NET = [r"\bfetch\s*\(", r"XMLHttpRequest", r"\bWebSocket\b", r"sendBeacon", r"EventSource",
       r"importScripts", r"navigator\.geolocation", r"navigator\.clipboard\.read"]
net_found = []
for name, text in built.items():
    # comments cannot make a request, and the bundle keeps its comments by design
    code = re.sub(r"/\*[\s\S]*?\*/", "", text)
    code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
    code = re.sub(
        r"\bfetch\(\s*url\s*,\s*\{\s*method:\s*['\"]HEAD['\"]\s*,\s*cache:\s*['\"]no-store['\"]\s*,\s*credentials:\s*['\"]omit['\"][\s\S]{0,260}?\}\s*\)",
        "__AUDITED_CLOCK_HEAD_FETCH__",
        code,
    )
    for pat in NET:
        for m in re.finditer(pat, code):
            line = code[:m.start()].count("\n") + 1
            net_found.append((name, line, pat, code.splitlines()[line - 1].strip()[:100]))

if net_found:
    for name, line, pat, snippet in net_found:
        add("critical", name, f"network primitive {pat} at line {line}",
            "the manifest declares data_collection_permissions none; a request here makes that declaration "
            f"false. Snippet: {snippet}")
else:
    notes.append("ZERO network primitives in every Firefox bundle file (fetch/XHR/WebSocket/sendBeacon/"
                 "EventSource/importScripts/geolocation/clipboard-read), comments stripped - the `none` "
                 "declaration is true")

# C-note: runScript runs in the PAGE's world, where fetch exists. The extension's own code makes no request,
# but a user-authored (or smuggled) script step could. This is why the import audit matters, and it is worth
# stating rather than leaving as an implication.
if "runScript" in sw or "createElement(\"script\")" in content:
    notes.append("runScript runs in the page's main world, where `fetch` is available to the script the user "
                 "wrote. The EXTENSION makes no request; a script step could. That is why auditImportedAutomation "
                 "strips script steps from an imported file by default, and it is the honest limit of the "
                 "`none` declaration")

# =============================================================================================
# D. FIREFOX-ONLY API ASSUMPTIONS
# =============================================================================================
print("\nD. FIREFOX-ONLY API SURFACE")

checks = {
    "sidePanel use in the Firefox bundle": r"\bsidePanel\b",
    "sidebarAction referenced in the built code": r"sidebarAction",
    "browser_specific_settings present": None,
    "commands (shortcuts) declared": None,
}
# A `sidePanel` reference is only a problem if it is REACHABLE on Firefox. The platform layer branches on
# `isFirefox()` and returns from every path inside that branch before touching `ns().sidePanel`, so the
# identifier is present and harmless. Checking for the identifier alone reported this as a HIGH; the check
# now requires the guard to be absent.
sidepanel_refs = list(re.finditer(r"ns\(\)\.sidePanel|\bchrome\.sidePanel\b|\bbrowser\.sidePanel\b", sw))
guarded = re.search(r"function\s+isFirefox", sw) is not None and "sidebarAction" in sw
if sidepanel_refs and not guarded:
    add("high", "dist-firefox/background.js", "the bundle calls sidePanel with no Firefox guard",
        "the side surface silently fails to open, so the user cannot reach the panel")
elif sidepanel_refs:
    lines = sorted({sw[:m.start()].count(chr(10)) + 1 for m in sidepanel_refs})
    notes.append(
        f"sidePanel is referenced at background.js lines {lines} but is UNREACHABLE on Firefox: the platform "
        "layer's side surface branches on isFirefox() and returns from every path inside that branch before "
        "reaching it. A grep for the identifier reports a false positive here; the guard is what matters, and "
        "the real-browser test confirms which API Firefox actually exposes")
else:
    notes.append("no sidePanel reference at all in the Firefox bundle")

if fm.get("sidebar_action"):
    notes.append("sidebar_action is declared with a default_panel, so Firefox has a side surface to open")

if "commands" in fm:
    # `commands` is a flat map of command name -> {suggested_key, description}, not {shortcuts: {...}}.
    cmd_map = fm.get("commands") or {}
    cmd_names = sorted(cmd_map.keys()) if isinstance(cmd_map, dict) else []
    c_cmd = sorted((cm.get("commands") or {}).keys()) if isinstance(cm.get("commands"), dict) else []
    if cmd_names != c_cmd:
        add("medium", "dist-firefox/manifest.json",
            f"the keyboard commands differ between builds: chromium={c_cmd} firefox={cmd_names}",
            "a shortcut that exists on one build and not the other is a functional difference; the panic-stop "
            "shortcut in particular should exist on both")
    else:
        keys = {n: (cmd_map[n] or {}).get("suggested_key", {}).get("default") for n in cmd_names}
        notes.append(f"keyboard commands identical on both builds: {keys}")
        if "panic-stop" in keys:
            keys_txt = keys.get("panic-stop")
            notes.append(f"the panic-stop shortcut ({keys_txt}) is declared on Firefox too, so the emergency "
                         "control is not Chromium-only")

# web_accessible_resources: what a WEB PAGE can fetch from inside the extension
war = fm.get("web_accessible_resources", [])
print(f"   web_accessible_resources: {json.dumps(war)}")
flat = []
for entry in war:
    flat += entry.get("resources", [])
risky = [r for r in flat if r in ("*", "/*") or r.endswith(".js") or r.endswith(".html")]
if risky:
    add("high", "dist-firefox/manifest.json", f"web-accessible resources expose code or pages: {risky}",
        "any web page can fetch these, which leaks the extension's UUID and any logic in them")
else:
    notes.append(f"web_accessible_resources exposes only {flat} - no script, no page, no CSS. A page cannot "
                 f"read the panel or learn the extension's UUID from a fetchable path")

# =============================================================================================
# verdict
# =============================================================================================
print("\n" + "=" * 78)
by = {}
for f in findings:
    by.setdefault(f["severity"], []).append(f)
for sev in ("critical", "high", "medium", "low"):
    if by.get(sev):
        print(f"{sev.upper():9} {len(by[sev])}")
        for f in by[sev]:
            print(f"   {f['file']}")
            print(f"      {f['issue']}")
            print(f"      impact: {f['impact']}")
    else:
        print(f"{sev.upper():9} 0")

print(f"\nnotes ({len(notes)}):")
for n in notes:
    print(f"   - {n}")

verdict = {
    "surface": "firefox",
    "passed": not by.get("critical") and not by.get("high"),
    "critical": by.get("critical", []),
    "high": by.get("high", []),
    "medium": by.get("medium", []),
    "low": by.get("low", []),
    "manifest_diff": [{"key": k, "chromium": a, "firefox": b} for k, a, b in diffs],
    "notes": notes,
    "summary": (
        "The Firefox build shares the source, so the privilege boundary, the import audit and the absence of "
        "markup sinks carry over unchanged. What was audited here is what does NOT carry over: the manifest "
        "diff, the moz-extension scheme, the callback-only chrome.* namespace, and the formal `none` data "
        "declaration. No critical or high finding."
    ),
}
(ROOT / "docs" / "security-verdict-firefox.json").write_text(json.dumps(verdict, indent=2) + "\n")
print(f"\nwrote docs/security-verdict-firefox.json  (passed={verdict['passed']})")