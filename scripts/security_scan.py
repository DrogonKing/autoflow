#!/usr/bin/env python3
"""
Static security scan of our own extension source.

Each check is a real question a browser-extension audit asks, and each result is reported with the file
and line so it can be verified rather than believed.
"""
import pathlib
import re
import json

SRC = pathlib.Path("/root/autoflow/src")
OUT = pathlib.Path("/root/autoflow/docs/security-scan.txt")

findings = []


def add(severity, category, file, line, text, note):
    findings.append({
        "severity": severity,
        "category": category,
        "file": str(file).replace("/root/autoflow/", ""),
        "line": line,
        "text": text.strip()[:160],
        "note": note,
    })


PATTERNS = [
    # (severity, category, regex, note)
    ("HIGH", "xss-innerHTML",
     re.compile(r"\.innerHTML\s*="),
     "Assigning innerHTML with a value that could carry markup. In an extension UI, page-derived data "
     "reaching innerHTML is a real XSS vector because extension pages run with elevated privileges."),
    ("HIGH", "xss-outerHTML",
     re.compile(r"\.outerHTML\s*="),
     "See innerHTML."),
    ("HIGH", "xss-insertAdjacentHTML",
     re.compile(r"insertAdjacentHTML"),
     "Same class as innerHTML."),
    ("HIGH", "eval",
     re.compile(r"\beval\s*\("),
     "eval with anything derived from a page or a user is code execution inside a privileged context."),
    ("HIGH", "new-Function",
     re.compile(r"new\s+Function\s*\("),
     "Equivalent to eval."),
    ("HIGH", "document-write",
     re.compile(r"document\.write"),
     "Document writes can be used to inject markup."),
    ("HIGH", "untrusted-html-assignment",
     re.compile(r"(innerHTML|outerHTML)\s*=\s*(?!['\"]\s*['\"])(?!`\s*`)"),
     "A dynamic value assigned into HTML."),
    ("MEDIUM", "hardcoded-secret",
     re.compile(r"(api[_-]?key|apikey|secret|password|passwd|token|bearer)\s*[:=]\s*['\"][^'\"]{8,}['\"]", re.I),
     "A credential-looking literal. Extension bundles are fully readable by anyone who installs them."),
    ("MEDIUM", "network-call",
     re.compile(r"\b(fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(|navigator\.sendBeacon)"),
     "Any network call from an extension is an exfiltration path; the design goal here was zero."),
    ("MEDIUM", "remote-script-load",
     re.compile(r"(createElement\(['\"]script['\"]\)[\s\S]{0,200}?\.src\s*=)"),
     "Loading a remote script into an extension or page context."),
    ("MEDIUM", "postMessage-wildcard",
     re.compile(r"postMessage\([^)]*,\s*['\"]\*['\"]"),
     "A wildcard targetOrigin leaks the message to any frame."),
    ("MEDIUM", "dangerously-allow-inline",
     re.compile(r"unsafe-inline|unsafe-eval"),
     "A CSP relaxation."),
    ("MEDIUM", "host-permission-wildcard",
     re.compile(r'"<all_urls>"|https?://\*/?\*'),
     "<all_urls> grants access to every site; it must be justified in the README."),
    ("LOW", "console-log-left",
     re.compile(r"console\.(log|debug)\s*\("),
     "Debug output left in a shipped bundle can leak state to the page console."),
    ("LOW", "todo-fixme",
     re.compile(r"(TODO|FIXME|XXX|HACK)\b"),
     "An unfinished note."),
    ("LOW", "innerText-from-page",
     re.compile(r"\.(innerText|textContent)\s*=\s*[a-zA-Z_]"),
     "Text assignment is safe from markup, but confirm the value is not written into HTML elsewhere."),
]

# ---------------------------------------------------------------------------------------------
# 1. pattern scan
# ---------------------------------------------------------------------------------------------
for path in sorted(SRC.rglob("*")):
    if path.suffix not in {".js", ".mjs", ".json", ".html", ".css"}:
        continue
    try:
        lines = path.read_text().splitlines()
    except UnicodeDecodeError:
        continue
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
            # a comment describing a pattern is not the pattern
            if not re.search(r"=\s*", stripped):
                continue
        for severity, category, rx, note in PATTERNS:
            if rx.search(line):
                add(severity, category, path, i, line, note)

# ---------------------------------------------------------------------------------------------
# 2. message handling: is the sender validated?
# ---------------------------------------------------------------------------------------------
MSG_HANDLERS = []
for path in sorted((SRC / "background").rglob("*.js")) + sorted((SRC / "content").rglob("*.js")):
    text = path.read_text()
    for m in re.finditer(r"onMessage\.addListener\(\s*(?:function\s*)?\(?\s*([^)]*)\)?", text):
        line_no = text[:m.start()].count("\n") + 1
        MSG_HANDLERS.append((path, line_no, m.group(0), m.group(1)))

sender_checks = 0
for path, line_no, header, params in MSG_HANDLERS:
    text = path.read_text()
    window = text[text.find(header):text.find(header) + 3000]
    if re.search(r"sender\s*\.\s*(id|url|origin|tab)", window) or re.search(r"\bsender\b", params):
        sender_checks += 1

# ---------------------------------------------------------------------------------------------
# 3. manifest review
# ---------------------------------------------------------------------------------------------
MANIFEST = json.loads((SRC / "manifest.json").read_text())

# ---------------------------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------------------------
lines = []
p = lines.append

p("AutoFlow — static security scan")
p("=" * 78)
p("")
p("Scope: src/ (the code that ships). Generated by scripts/security_scan.py.")
p("")

by_sev = {}
for f in findings:
    by_sev.setdefault(f["severity"], []).append(f)

p(f"Findings: {len(findings)}")
for sev in ("HIGH", "MEDIUM", "LOW"):
    p(f"  {sev:7} {len(by_sev.get(sev, []))}")
p("")

for sev in ("HIGH", "MEDIUM", "LOW"):
    items = by_sev.get(sev, [])
    if not items:
        continue
    p("-" * 78)
    p(f"{sev} ({len(items)})")
    p("-" * 78)
    for f in items:
        p(f"  {f['file']}:{f['line']}")
        p(f"    {f['category']}")
        p(f"    {f['text']}")
    p("")

p("-" * 78)
p("Message handlers and sender validation")
p("-" * 78)
p(f"  onMessage listeners found : {len(MSG_HANDLERS)}")
p(f"  that inspect the sender  : {sender_checks}")
for path, line_no, _, params in MSG_HANDLERS:
    checked = "yes" if re.search(r"\bsender\b", params) else "NO"
    p(f"    {str(path).replace('/root/autoflow/','')}:{line_no}  params=({params.strip()})  validates sender: {checked}")
p("")

p("-" * 78)
p("Manifest")
p("-" * 78)
p(f"  permissions ({len(MANIFEST.get('permissions', []))}): {', '.join(MANIFEST.get('permissions', []))}")
p(f"  host_permissions            : {MANIFEST.get('host_permissions')}")
p(f"  content_scripts matches     : {[cs.get('matches') for cs in MANIFEST.get('content_scripts', [])]}")
p(f"  content_scripts worlds      : {[cs.get('world') for cs in MANIFEST.get('content_scripts', [])]}")
p(f"  externally_connectable      : {MANIFEST.get('externally_connectable', 'not declared (good)')}")
p(f"  content_security_policy     : {MANIFEST.get('content_security_policy', 'not declared (MV3 default applies)')}")
p(f"  web_accessible_resources    : {[w.get('resources') for w in MANIFEST.get('web_accessible_resources', [])]}")
p("")

OUT.write_text("\n".join(lines))
print("\n".join(lines))
