#!/usr/bin/env python3
"""
Build a single compact review packet for an independent reviewer.

WHY THIS EXISTS — the two previous delegated reviews both failed the same way, and the cause is measurable:

    subagent 1:  16 API calls, 15m16s, read 7 files (~140 KB accumulated context) -> final answer TIMED OUT
    subagent 2:   9 API calls, 24m45s, read 7 files (~140 KB accumulated context) -> final answer TIMED OUT

    "API call failed after 3 retries: Non-streaming API call timed out after 150s"

Neither failed to read the code. Both failed while COMPOSING the answer, with a context full of large files.
So the fix is not a better prompt, it is less to read: one small file containing exactly the code a security
judgement needs, with real file:line references so every claim can be checked.

The packet is deliberately adversarial in what it includes:
  - the GUARDS, so "verified absent" can be a real finding rather than an assumption
  - the SUSPICIOUS parts (a `js` condition source, runScript, the import audit, uploads, markup sinks), so the
    reviewer has something to attack rather than something to agree with
  - the WRONG versions where a fix is interesting, because a reviewer who cannot see the guard can only guess
"""
import pathlib
import re

SRC = pathlib.Path("/root/autoflow/src")
OUT = pathlib.Path("/root/autoflow/docs/review-packet.md")

packet = []
notes = []


def grab(rel, start_anchor, max_lines, end_anchor=None, label=None, drop_comments=False):
    """Pull a region of a file by anchor, with real line numbers preserved."""
    text = (SRC / rel).read_text()
    lines = text.split("\n")
    start = None
    for i, line in enumerate(lines):
        if start_anchor in line:
            start = i
            break
    if start is None:
        notes.append(f"ANCHOR NOT FOUND: {rel} :: {start_anchor[:60]}")
        return None, None
    end = min(len(lines), start + max_lines)
    if end_anchor:
        for j in range(start + 1, min(len(lines), start + max_lines + 200)):
            if end_anchor in lines[j]:
                end = j + 1
                break
    chunk = lines[start:end]
    numbered = "\n".join(f"{start + k + 1:5}| {l}" for k, l in enumerate(chunk))
    return (label or start_anchor), numbered


def section(title, body):
    """Emit a code section with the SOURCE line numbers only.

    read_file adds its own outer line number on top of the source numbers already in the body, so a line came
    out as `501| 361| ...`. A reviewer citing a finding needs the real source line, and two numbers invite
    citing the wrong one. The outer number is stripped here and the header says which remains.
    """
    cleaned = []
    for line in body.split("\n"):
        m = re.match(r"^\s*(\d+)\|\s*(\d+)\| (.*)$", line)
        if m:
            cleaned.append(f"{int(m.group(2)):5}| {m.group(3)}")
        else:
            cleaned.append(line)
    cleaned = "\n".join(cleaned)
    packet.append(f"\n### {title}\n")
    packet.append("_Line numbers below are the REAL line numbers in the source file._\n")
    # The fence carries its own trailing newline. The packet is joined with "" (not "\n"), so without the
    # "\n" inside this literal the fence and the first code line end up on the SAME line:
    #     ```javascript  530| const CONTENT_SCRIPT_MESSAGES = new Set([
    # which read_file then renders as a missing first line. That affected 18 sections - one line of every
    # section was invisible to the reviewer. Appending "" fixes nothing because the join is not by newline.
    packet.append("```javascript\n")
    packet.append(cleaned)
    packet.append("```\n")


packet.append("""# AutoFlow — independent security review packet

A Manifest V3 browser extension (Chrome/Edge + Firefox) that automates browsers: it clicks, fills forms,
records steps and runs them on a schedule. It injects a content script into every page (`<all_urls>`,
`all_frames: true`). The service worker can drive tabs, downloads, notifications and scripting.
`externally_connectable` is NOT declared. The stated design goal is **zero network calls**. A `runScript` step
injects a `<script>` into a page's main world on purpose — a documented feature, not a bug, but assess what it
can reach.

This packet contains the security-relevant code with real line numbers. You do NOT need to read any other
file. Judge it as an attacker.
""")

# =============================================================================================
# 1. the manifest, both builds
# =============================================================================================
cm = (SRC / "manifest.json").read_text()
packet.append("\n### The manifest (Chromium build; the Firefox build differs as noted)\n")
packet.append("```json")
packet.append(cm.strip()[:2600])
packet.append("```\n")
packet.append("""Firefox build differences: `background.scripts` instead of `service_worker`; `sidePanel` permission
removed; `sidebar_action` added; `browser_specific_settings.gecko` with an id and
`data_collection_permissions: {required:["none"], optional:[]}`.
""")

# =============================================================================================
# 2. THE PRIVILEGE BOUNDARY - the load-bearing control
# =============================================================================================
body = grab("background/service-worker.js", "const CONTENT_SCRIPT_MESSAGES", 60,
            label="the allowlist and the sender classifier")
if body[1]:
    section("The content-script allowlist and the sender classifier (service-worker.js)", body[1])

body = grab("background/service-worker.js", "api.runtime.onMessage.addListener", 120,
            label="the message dispatch")
if body[1]:
    section("The worker's message dispatch (service-worker.js)", body[1])

# the guard lives inline in the onMessage listener, so the anchor is the check itself
body = grab("content/content.js", "sender?.id !== api.id", 45, label="the content-script guard")
if body[1]:
    section("The content script's sender guard (content.js)", body[1])

packet.append("""NOTE: the content script is INJECTED INTO EVERY PAGE, so a web page is the cheapest attacker. The
question is whether a page, or page-controlled data, can reach a privileged action. The page itself cannot
call `chrome.runtime.sendMessage` (no `externally_connectable`), but the content script in that page can.
""")

# =============================================================================================
# 3. CODE EXECUTION
# =============================================================================================
body = grab("content/content.js", "function runInPage(code)", 65, label="runInPage")
if body[1]:
    section("runInPage — the script injection (content.js)", body[1])

body = grab("content/content.js", "case 'extract'", 62, label="the extract case")
if body[1]:
    section("The extract case (content.js)", body[1])

body = grab("background/storage.js", "export function auditImportedAutomation", 90,
            label="auditImportedAutomation")
if body[1]:
    section("auditImportedAutomation — what an imported file is checked for (storage.js)", body[1])

# The ENFORCEMENT, not just the audit. The first version of this packet stopped at the audit and the reviewer
# correctly wrote "enforcement may exist below line 472 (not shown)" - which made their finding a report about
# the exhibit rather than about the code. Showing a guard's preamble without the guard invites exactly that, so
# both are included and the connection is stated.
body = grab("background/storage.js", "export async function importAll", 60, label="importAll")
if body[1]:
    section("importAll — where the audit's verdict is ENFORCED (storage.js)", body[1])
    packet.append("""NOTE: `importAll` calls `auditImportedAutomation` per automation and then, at the line reading
`const hasScript = concerns.some((c) => c.severity === 'high')`, refuses to import that automation unless
`allowScripts` was passed. `skipped[]` reports it. Confirm the enforcement is reachable for every path that
reaches the audit, and that `skipped` is what the caller shows the user.
""")

body = grab("background/storage.js", "function allConditions", 60, label="allConditions")
if body[1]:
    section("allConditions — which conditions the audit reaches (storage.js)", body[1])

# =============================================================================================
# 4. CONDITION EVALUATION - the `js` source question
# =============================================================================================
body = grab("core/engine/conditions.js", "export function evaluateCondition", 60,
            label="evaluateCondition")
if body[1]:
    section("evaluateCondition — where a condition source is resolved (conditions.js)", body[1])

body = grab("background/service-worker.js", "async readCondition", 25, label="readCondition")
if body[1]:
    section("The worker's readCondition — what it asks the page for (service-worker.js)", body[1])

body = grab("content/content.js", "function observe(finder, condition)", 30, label="observe")
if body[1]:
    section("The page's observe() — how it answers (content.js)", body[1])

packet.append("""A condition source `'js'` exists in the model: `steps.js:194` requires `c.js` to be present when
`source === 'js'`, the type documentation lists it at `steps.js:168`, and the UI can display it. Trace whether
anything ever EVALUATES it.
""")

# =============================================================================================
# 5. XSS
# =============================================================================================
body = grab("ui/panel/panel.js", "const el = (tag, props", 30, label="the el helper")
if body[1]:
    section("The panel's element helper (panel.js) — this is how every node is created", body[1])

body = grab("ui/options/options.js", "const el = (tag, props", 30, label="the options el helper")
if body[1]:
    section("The options page's element helper (options.js)", body[1])

# =============================================================================================
# 4b. THE TEMPLATE ENGINE - where a `${...}` expression is resolved
# =============================================================================================
body = grab("core/model/templates.js", "export function evaluateExpression", 60, label="evaluateExpression")
if body[1]:
    section("evaluateExpression - the whole template engine, which COMPILES NOTHING (templates.js)", body[1])
    packet.append("""NOTE: a `${...}` template is resolved by walking a path (`a.b.c`), looking it up in the variable map,
and joining strings. There is no eval, no Function, no new Function - so a value taken from a page can become a
string that is typed into a field, and cannot become code.
""")

# =============================================================================================
# 5b. THE PLATFORM LAYER - the guard that makes a Chromium-only API call unreachable on Firefox
# =============================================================================================
body = grab("platform/api.js", "export function isFirefox", 20, label="isFirefox")
if body[1]:
    section("isFirefox — the discriminator (platform/api.js)", body[1])

body = grab("platform/api.js", "  side: {", 55, label="the side surface")
if body[1]:
    section("The side surface — why a `sidePanel` reference is unreachable on Firefox (platform/api.js)", body[1])
    packet.append("""NOTE: `side` branches on `isFirefox()` and **returns from every path inside that branch**
before reaching `ns().sidePanel`. A search for the identifier therefore reports a `sidePanel` use in the
Firefox bundle that can never execute. The reference is present and unreachable; that distinction is the point.
""")

# =============================================================================================
# 6. UPLOADS
# =============================================================================================
body = grab("background/service-worker.js", "case 'add-upload-file'", 45, label="upload handling")
if body[1]:
    section("Upload handling (service-worker.js)", body[1])

body = grab("background/storage.js", "export async function setUploadFile", 40, label="setUploadFile")
if body[1]:
    section("setUploadFile (storage.js)", body[1])

# =============================================================================================
# 7. what to answer
# =============================================================================================
packet.append("""
### What to answer

1. Can a **web page** reach a privileged action (a run, a save, an import, a schedule, an upload)? Name the
   guard that stops it, or the attack that gets through.
2. Does any code **execute** a `js` condition, or anything else from a stored/imported automation, in the
   SERVICE WORKER (which holds every permission)?
3. Can a value **extracted from a web page** reach a markup or eval sink in the panel or options page?
4. Can an imported `.json` smuggling a `runScript` step past the audit? What does the audit actually do?
5. Does any code make a **network request**?

Answer with ONLY this JSON, and keep every string under 300 characters:

{"passed": true/false,
 "critical": [{"file":"","line":0,"issue":"","attack":""}],
 "high": [], "medium": [], "low": [],
 "verified_absent": ["a specific attack you tried to construct and could NOT make work, naming the guard"],
 "summary": "at most two sentences"}

Rules: critical/high non-empty means passed is false. Only list a finding if you can name the file and the
concrete attack. Put what you could NOT break in verified_absent — that is as useful as the findings. Do not
give a finding for code you were not shown; say so in the summary instead.
""")

OUT.write_text("".join(packet))
size = OUT.stat().st_size
print(f"wrote {OUT}  ({size} bytes, ~{size // 4} tokens)")
if notes:
    print("\nanchors that did not match (fix these or the packet is incomplete):")
    for n in notes:
        print(f"  - {n}")
else:
    print("every anchor matched")

# sanity: the packet must actually contain the guards it claims to
checks = {
    "the allowlist": "CONTENT_SCRIPT_MESSAGES",
    "the sender classifier": "classifySender",
    "the content guard": "sender?.id !==",
    "runInPage": "runInPage",
    "the import audit": "auditImportedAutomation",
    "the extract case": "case 'extract'",
    "condition evaluation": "evaluateCondition",
    "the page's observe": "function observe",
    "the el helper": "createElement",
}
text = OUT.read_text()
print("\npacket self-check:")
for label, needle in checks.items():
    print(f"  {'ok  ' if needle in text else 'MISSING'} {label}")
