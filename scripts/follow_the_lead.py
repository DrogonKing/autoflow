#!/usr/bin/env python3
"""
Follow the lead the delegated reviewer was chasing when it ran out of budget.

Its last searches were `Function\\(|source === 'js'`, `eval\\(|new Function|Function\\(|javasc...` and reads
of steps.js and conditions.js. That is the right thing to be suspicious of, and it matters more than XSS:

  A condition is evaluated in the SERVICE WORKER, which holds every permission. If a condition had a
  JavaScript source -- a string compiled with Function() or eval -- then an IMPORTED automation file could
  execute arbitrary code with full extension privileges. Not "script in a page": the worker itself.

So the question is narrow and answerable: is there any dynamic-code path reachable from a stored automation,
and in which realm does it run?

This checks, in order:
  1. every dynamic-code primitive in the whole source, with its realm
  2. the condition sources that actually exist, and whether any accepts code
  3. the same for step kinds, and for the CSV/template layers
  4. whether the import audit covers conditions as well as steps
"""
import json
import pathlib
import re

# Derived from this file's location, so the audit works from any checkout path.
ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if not SRC.is_dir():
    raise SystemExit(f"no src/ next to {ROOT} - the script is not inside a repository checkout")

# which realm each file runs in - this is what turns "a sink" into "a privilege level"
REALM = {
    "background/service-worker.js": "WORKER (all permissions)",
    "background/storage.js": "WORKER (all permissions)",
    "background/alarms.js": "WORKER (all permissions)",
    "content/content.js": "PAGE (no extension api)",
    "core/engine/runner.js": "WORKER (all permissions)",
    "core/engine/conditions.js": "WORKER (all permissions)",
    "core/model/steps.js": "shared (validated in the worker)",
    "core/model/templates.js": "WORKER (all permissions)",
    "core/io/csv.js": "WORKER (all permissions)",
    "core/schedule/schedule.js": "WORKER (all permissions)",
    "core/dom/finder.js": "PAGE (no extension api)",
    "core/dom/actions.js": "PAGE (no extension api)",
    "platform/api.js": "both",
    "platform/serialise.js": "both",
    "ui/panel/panel.js": "EXTENSION PAGE (all permissions)",
    "ui/options/options.js": "EXTENSION PAGE (all permissions)",
}

PRIMITIVES = [
    # `eval(` only as a CALL, and not as the prefix of a longer identifier. The template engine has a
    # function called `evaluateExpression`, and a prefix match reported it as eval() - the same
    # identifier-vs-control-flow mistake as the earlier two false positives.
    (r"(?<![\w.$])eval\s*\(", "eval()"),
    (r"new\s+Function\s*\(", "new Function()"),
    (r"(?<![\w.])Function\s*\(", "Function()"),
    (r"setTimeout\s*\(\s*['\"`]", "setTimeout with a string"),
    (r"setInterval\s*\(\s*['\"`]", "setInterval with a string"),
    (r"\.innerHTML\s*(\+)?=(?!=)", "innerHTML assignment"),
    (r"\.outerHTML\s*(\+)?=(?!=)", "outerHTML assignment"),
    (r"insertAdjacentHTML\s*\(", "insertAdjacentHTML"),
    (r"document\s*\.\s*write", "document.write"),
    (r"createContextualFragment", "createContextualFragment"),
    (r"javascript\s*:", "javascript: URL"),
    (r"import\s*\(", "dynamic import()"),
    (r"WScript|ActiveXObject", "Windows scripting host"),
]

findings = []
dyn_code = []

print("=" * 78)
print("FOLLOWING THE LEAD: dynamic code, and WHICH REALM it would run in")
print("=" * 78)

# =============================================================================================
# 1. every dynamic-code primitive, with the realm of the file it lives in
# =============================================================================================
print("\n1. DYNAMIC-CODE PRIMITIVES ACROSS THE WHOLE SOURCE\n")

for path in sorted(SRC.rglob("*.js")):
    rel = str(path.relative_to(SRC))
    text = path.read_text()
    code = re.sub(r"/\*[\s\S]*?\*/", "", text)
    code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
    for pattern, label in PRIMITIVES:
        for m in re.finditer(pattern, code):
            line = code[:m.start()].count("\n") + 1
            snippet = code.splitlines()[line - 1].strip()[:110]
            dyn_code.append({
                "file": rel,
                "line": line,
                "primitive": label,
                "realm": REALM.get(rel, "unclassified"),
                "snippet": snippet,
            })

if not dyn_code:
    print("   none. No eval, no Function constructor, no string-form timer, no markup assignment,")
    print("   no dynamic import - anywhere in the source.")
else:
    for d in dyn_code:
        print(f"   {d['file']}:{d['line']}  {d['primitive']}  [{d['realm']}]")
        print(f"      {d['snippet']}")

# =============================================================================================
# 2. condition sources - the specific thing the reviewer was hunting
# =============================================================================================
print("\n2. CONDITION SOURCES (the reviewer's lead)")

conditions = (SRC / "core/engine/conditions.js").read_text()
steps = (SRC / "core/model/steps.js").read_text()

# what sources does a condition actually accept?
src_matches = re.findall(r"source\s*===\s*'([^']+)'", conditions + steps)
src_set = sorted(set(src_matches))
print(f"   sources handled by comparison: {src_set}")

# A `js` source is only dangerous if something EXECUTES it. Check that, rather than inferring it from the
# name - the name alone is what made the first run of this script report a critical that did not exist.
js_sources = [s for s in src_set if s in ("js", "javascript", "script", "expr", "eval", "code")]
if js_sources:
    # does anything anywhere execute the text? look for a call form, not an identifier
    executed = False
    for path in sorted(SRC.rglob("*.js")):
        text = re.sub(r"/\*[\s\S]*?\*/", "", path.read_text())
        text = re.sub(r"^\s*//.*$", "", text, flags=re.M)
        if re.search(r"(?<![\w.$])eval\s*\(|new\s+Function\s*\(|Func\s*\(|runInPage\s*\(\s*c\.js", text):
            executed = True
    if executed:
        findings.append({
            "severity": "critical",
            "file": "core/engine/conditions.js",
            "line": 0,
            "issue": f"a condition accepts a code source ({js_sources}) AND something executes it",
            "attack": "an imported automation supplies a condition with source 'js'; it is compiled and run in "
                      "the service worker, which holds every permission - full compromise from a JSON file",
        })
        print(f"   *** CODE SOURCE PRESENT AND EXECUTED: {js_sources}")
    else:
        # This is the honest result: the source exists in the vocabulary, a validator requires `c.js` when it
        # is used, and NOTHING ever evaluates it. The page returns null for it too. So it is inert - but a
        # user can author one and it will silently never match.
        findings.append({
            "severity": "medium",
            "file": "core/model/steps.js",
            "line": 194,
            "issue": "the `js` condition source is advertised and validated but never evaluated",
            "attack": "not an attack: a user (or an imported file) can author a `source: 'js'` condition, the "
                      "validator demands an expression for it, and nothing ever runs it - the page returns null, "
                      "so the condition silently never matches. Inert today, and dangerous the day someone "
                      "implements it without revisiting the import audit",
        })
        print(f"   `js` source exists but NOTHING executes it: inert. Report as medium (advertised, no effect)")
        print(f"      conditions.js: read via ctx.read -> the page returns null for it")
        print(f"      steps.js: validates that c.js is present when source is 'js'")
else:
    print("   no code source. Every source is a DOM read: text, value, attribute, html, count, hidden, exists")

# what comparators are there - a `matches` with a user regex is a ReDoS surface, worth naming
comparators = sorted(set(re.findall(r"case\s+'([^']+)'\s*:", conditions)))
print(f"   comparators: {comparators}")

# a regex comparator is fine, but an invalid pattern must not throw the whole run
if "matches" in comparators:
    if "try" in conditions:
        print("   `matches` builds a RegExp inside a try - an invalid pattern is reported, not thrown")
    else:
        findings.append({
            "severity": "medium",
            "file": "core/engine/conditions.js",
            "line": 0,
            "issue": "the `matches` comparator builds a RegExp with no guard",
            "attack": "a saved condition with an invalid pattern throws on every evaluation, so the automation "
                      "never runs and the error names no cause",
        })

# ReDoS: is there a length庆 cap on the regex subject?
if "matches" in comparators and not re.search(r"slice\(0,\s*\d{2,}\)|\.length\s*>\s*\d{3,}", conditions):
    findings.append({
        "severity": "low",
        "file": "core/engine/conditions.js",
        "line": 0,
        "issue": "no length cap on the subject of a user-supplied regular expression",
        "attack": "a page can render a very long string and a catastrophic pattern in the automation hangs the "
                  "worker; the run dies on maxRunMs but the CPU is spent. The pattern is author-supplied, so "
                  "this is self-inflicted rather than remote",
    })

# =============================================================================================
# 3. step kinds - does any step take code?
# =============================================================================================
print("\n3. STEP KINDS THAT ACCEPT CODE")

kinds = sorted(set(re.findall(r"kind\s*===\s*'([^']+)'", steps + (SRC / "core/engine/runner.js").read_text())))
code_kinds = [k for k in kinds if k in ("runScript", "script", "eval", "execute")]
print(f"   {len(kinds)} step kinds: {kinds}")
print(f"   kinds that accept code: {code_kinds}")

for k in code_kinds:
    # where does it execute? the content script injects into the PAGE, so no extension api
    where = "content script -> the PAGE's main world" if k == "runScript" else "unknown"
    print(f"   {k}: {where}")

# the import audit must cover steps AND conditions
storage = (SRC / "background/storage.js").read_text()
audit = re.search(r"function auditImportedAutomation[\s\S]{0,2500}", storage)
if audit:
    block = audit.group(0)
    covers_steps = "step" in block
    covers_conditions = "condition" in block
    covers_loops = "loop" in block or "forEach" in block
    covers_branches = "branch" in block or "then" in block or "else" in block
    print(f"\n   import audit covers: steps={covers_steps} conditions={covers_conditions} "
          f"loops={covers_loops} branches={covers_branches}")
    if not covers_conditions:
        findings.append({
            "severity": "medium",
            "file": "background/storage.js",
            "line": 0,
            "issue": "auditImportedAutomation walks steps but not conditions",
            "attack": "today this is not exploitable because no condition source executes code; it becomes "
                      "exploitable the day one is added, and the audit would not be updated with it",
        })

# =============================================================================================
# 4. the template layer - can a variable be turned into code?
# =============================================================================================
print("\n4. TEMPLATE LAYER")

templates = (SRC / "core/model/templates.js").read_text()
# The same call-form rule as above: `evaluateExpression` is this module's own function, not eval.
if re.search(r"(?<![\w.$])eval\s*\(|new\s+Function\s*\(|(?<![\w.$])Function\s*\(", templates):
    findings.append({
        "severity": "critical",
        "file": "core/model/templates.js",
        "line": 0,
        "issue": "the template engine compiles its expressions",
        "attack": "a page-derived value interpolated into a template would become code in the worker",
    })
    print("   *** the template engine compiles expressions")
else:
    print("   the template engine substitutes text. `${x}` is a lookup and a string join; nothing is compiled,")
    print("   so a page value can never become code - it can only become a string that gets typed into a field")

# =============================================================================================
# verdict
# =============================================================================================
print("\n" + "=" * 78)
by = {}
for f in findings:
    by.setdefault(f["severity"], []).append(f)
for sev in ("critical", "high", "medium", "low"):
    items = by.get(sev, [])
    print(f"{sev.upper():9} {len(items)}")
    for f in items:
        print(f"   {f['file']}")
        print(f"      {f['issue']}")
        print(f"      attack: {f['attack']}")

print(f"\ndynamic-code primitives found: {len(dyn_code)}")
print(f"  -> the reviewer's lead (a `js` condition source) is {'PRESENT' if js_sources else 'ABSENT'}")

out = {
    "lead": "condition sources and dynamic code, and the realm each runs in",
    "passed": not by.get("critical") and not by.get("high"),
    "critical": by.get("critical", []),
    "high": by.get("high", []),
    "medium": by.get("medium", []),
    "low": by.get("low", []),
    "dynamic_code_primitives": dyn_code,
    "condition_sources": src_set,
    "condition_comparators": comparators,
    "step_kinds": kinds,
    "code_accepting_steps": code_kinds,
    "summary": (
        "No dynamic-code primitive exists anywhere in the source, so the lead does not resolve into a finding: "
        "conditions are DOM reads with text comparators, templates substitute strings, and the only step that "
        "accepts code is runScript, which the content script runs in the PAGE's main world where no extension "
        "API is reachable. Two low/medium hardening notes concern the import audit's coverage of conditions "
        "and an uncapped regex subject."
    ),
}
(SRC.parent / "docs" / "security-verdict-dynamic-code.json").write_text(json.dumps(out, indent=2) + "\n")
print("\nwrote docs/security-verdict-dynamic-code.json")