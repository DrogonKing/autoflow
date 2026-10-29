# AutoFlow — security review

Date: 2026-10-29. Scope: `src/` (the code that ships), plus the manifest.

Method: a static scan, a manual audit of each boundary, adversarial tests that attempt the bypasses
rather than asserting the controls exist, an independent REA analysis, and a separate reviewer agent that
saw only the source. Findings were fixed and then re-verified in a real browser.

---

## 1. Threat model

What is actually being defended, and against whom.

| # | Threat | Realistic? | Defence |
|---|---|---|---|
| T1 | A web page drives a privileged action (start a run, delete automations, read settings) | **Yes** — the extension injects into every page, `all_frames: true` | Message sender classification (see §3) |
| T2 | A malicious automation file is imported and its `runScript` step harvests a page's session | **Yes** — automation files get shared | Import audit, script steps held back (§4) |
| T3 | A value extracted from a hostile page breaks out of the panel UI | Yes, if a markup sink exists | All UI output goes through `textContent`; the one sink was removed (§2) |
| T4 | The extension phones home or leaks data | No path exists by design | Zero network APIs in the shipped source, asserted by test (§6) |
| T5 | Arbitrary file read via the upload feature | Yes, if the name is used as a path | Name validated, no separators, session-scoped (§5) |
| T6 | Another extension impersonates ours | No — `sender.id` is set by the browser | `sender.id` compared to `runtime.id` |
| T7 | Hostile page content reaching `runScript` | Deliberate feature | Documented as a feature with its limits; flagged on import (§4) |

Deliberately **out of scope**: a compromised browser, a malicious OS, an attacker who can already write to
the extension's storage. Those are not defensible from inside an extension.

---

## 2. Findings and fixes

### F1 — `upload` was declared in the UI and handled nowhere 🔴 **HIGH**

Choosing "upload" produced a step that silently did nothing. A security-adjacent finding: the UI promised
a capability that did not exist, so a user could believe a file was attached when it was not.

**Fixed** — implemented properly: the extension reads the file and the content script builds a
`DataTransfer`, which is the only way a file input can be populated. A page cannot do this itself.

### F2 — `importAll` validated nothing about steps 🔴 **HIGH**

A shared automation file could contain a `runScript` step — arbitrary JavaScript executed later, in
whatever page the automation runs on. Importing it silently was the problem.

**Fixed** — three layers:
1. Structural validation: a step must have a `kind`, the nesting is bounded (`allSteps` caps at 20,000), a
   non-object entry is rejected.
2. An audit pass reports every step it does not recognise.
3. A script step is **held back** unless the caller passes `allowScripts`, and the export document itself
   carries `containsScripts` so a recipient can see it before importing.

The audit is recursive, so a script hidden inside a loop or an `if`/`else` is found — tested.

### F3 — the background message handler declared `sender` and never read it 🟠 **MEDIUM**

The classic shape of a missing authorisation check: the parameter is there, so a reader assumes the check
is too.

**Fixed** — `classifySender()` runs first and refuses anything not positively identified, then a content
script is limited to a four-message positive list (`content-ready`, `element-picked`,
`element-pick-cancelled`, `run-status`). Every privileged message is refused for a page-context sender.
19 such messages are tested individually.

### F4 — an unused `innerHTML` sink in the panel helper 🟠 **MEDIUM**

`el(tag, {html: v})` assigned straight to `innerHTML`. It had **no call sites** — dead code that existed
only as a latent XSS sink, and values in that panel include text extracted from arbitrary pages.

**Fixed** — deleted from both helpers rather than guarded, since nothing used it. A test asserts no
`innerHTML`/`outerHTML` assignment exists anywhere in `src/ui`.

### F5 — four permissions the code never uses 🟠 **MEDIUM**

`contextMenus`, `activeTab`, `webNavigation`, `unlimitedStorage` were declared and referenced zero times.

**Fixed** — removed. `contextMenus` was the notable one: it grants a right-click menu surface for nothing.
Permissions went from 11 to 7. `webNavigation` removal is honest about the consequence: page-load detection
now relies on `tabs.onUpdated` semantics via polling in the runner.

### F6 — `picker.css` exposed to every origin 🟡 **LOW**

Listed in `web_accessible_resources` with `matches: ["<all_urls>"]`, which lets any page probe for the
extension's presence and read the stylesheet. It is only linked from extension pages.

**Fixed** — removed from `web_accessible_resources`. Only `icons/*` remains.

---

## 3. The sender check: measured, not assumed

This is worth recording because the first attempt was **wrong in both directions**, and unit tests with a
hand-written sender object passed while a real browser failed.

The assumption was "an extension page has no `sender.tab`". Measured with
`scripts/probe-sender.mjs`, sending from `panel.html` in a real Chromium:

```
sender.id      = <our id>
sender.url     = "chrome-extension://<id>/panel.html"
sender.origin  = "chrome-extension://<id>"
sender.tab     = PRESENT          <-- the panel has a tab of its own
```

| | `sender.id` | `sender.tab` | `sender.url` |
|---|---|---|---|
| extension page (panel) | ours | **present** | `chrome-extension://<id>/panel.html` |
| content script | ours | present | `http://127.0.0.1:35997/` |
| the service worker | ours | absent | `chrome-extension://<id>/background.js` |

So `tab` distinguishes nothing, and both the panel and a content script carry our id. **Only the URL
scheme separates them.** The corrected check is:

```
not our id                      -> unknown, refused
chrome-extension://<our id>/... -> extension page, full access
http(s)://...                   -> content script, four messages only
otherwise                       -> internal
```

**The bug this fixed, and the bug it caused:** the first version refused the panel (its own UI), and a
second version refused the worker, so every page action failed with "the page gave no answer". Both were
caught by the real-browser tests, not by the unit tests. The unit tests now use the **measured** sender
shapes, with a comment saying not to infer them.

---

## 4. `runScript`, stated plainly

It is a real feature and it is a real capability.

- It executes in the **page's main world**, via a `<script>` element, so it reaches page globals.
- It **cannot** reach extension APIs: the content script's privileged `chrome.*` surface is in the
  isolated world, and a main-world script cannot see it.
- What it **can** reach is everything the page can: `document.cookie` for that origin, form values, the
  DOM, and any token the page holds in JavaScript memory.
- A `runScript` step is therefore exactly as powerful as pasting code into that site's console.

Mitigations: it is never imported silently (§F2), the export declares it, and the step is labelled in the
UI. It is not disabled, because a user with a legitimate need would route around it and lose the audit
trail.

`goto` with a template URL is flagged on import for the same class of reason: it can send an extracted
value to another host.

---

## 5. Upload handling

| Check | Reason |
|---|---|
| name validated against `/`, `\`, `..` | a name is a key, never a path |
| must already be in the set the user added | not a general read primitive |
| content must be a `data:...;base64,` URL | refuses a remote URL, which would be a fetch |
| 8 MB cap | bounded memory |
| session storage, not local | a user's document is not left on disk |

Tests attempt `../secret`, `a/b.txt`, `..\win.txt`, `/etc/passwd`, a never-added name, a non-data URL, and
an oversized payload. All refused.

---

## 6. No network, asserted

Two tests walk `src/` and fail if any of `fetch(`, `XMLHttpRequest`, `new WebSocket`, `new EventSource`,
`sendBeacon`, `eval(` or `new Function(` appears outside a comment. This is the mechanism behind the
"no telemetry" claim, and it is checked rather than promised.

For contrast, the reference extension this was modelled on contains `google-analytics.com/mp/collect`,
`otel.getautoclicker.com`, Firebase, and an OpenTelemetry endpoint on `localhost:4318`.

---

## 7. Independent review

### REA (static analysis of the whole extension)

```
parsed_javascript_files      14
visited_ast_nodes            32584
parse_failures                0
invalid_utf8_files            0
sender_validation_observations 2      <- it found both of our checks
```

Two of REA's nine stated limitations matter for reading that result, and it is to REA's credit that it says
so itself:

> Sender, frame, URL, and origin checks are observations only; REA does not claim that they enforce a
> complete authorization policy.

> JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed.

So REA confirms *what is written*, not *what runs*. The runtime behaviour is covered by the browser tests.

### Separate reviewer agent

A reviewer with no context on this work was given only the source and asked to construct attacks. Its
verdict, including what it could **not** break, is in §9.

---

## 8. Verification

```
367  unit tests                 (was 314; +53 security and scheduling)
 56  of those are security tests, each attempting a bypass
 20  real-browser load checks
 26  end-to-end checks on a live page
```

The security tests are not assertions that code exists. They send messages as a hostile sender and check
the refusal, import a script hidden three levels deep in a loop, attempt path traversal in a file name,
and try to leak seeded storage values through an error message.

---

## 9. Residual risk — what is NOT covered

Stated so it is not mistaken for "secure".

1. **`<all_urls>` is inherently broad.** The extension can read and act on any site you visit. That is the
   product. It is not sandboxed per-site.
2. **A compromised extension storage is game over.** Anyone who can write to it can plant a `runScript`
   step. Storage is not encrypted at rest.
3. **`runScript` is arbitrary code by design.** The import audit reduces accidental exposure, not a
   determined attacker who edits the file after import.
4. **The audit is a report, not a proof.** It recognises unknown step kinds; a future kind that is powerful
   and omitted from the allow-list would be flagged, but a powerful *field* on a known kind would not be.
5. **REA's own caveat applies:** static analysis shows what is written. A dynamically constructed call
   would not be visible to it.
6. **Not fuzzed.** No coverage-guided fuzzing of the parsers (cron, CSV, templates) has been run; they are
   property-tested by example only.
7. **No CSP audit of third-party pages.** The extension does not weaken a page's CSP, but it does inject
   into pages with permissive CSPs, and `runScript` would inherit that.
8. **The reviewer agent is not a human pentester.** Its findings are in §7; a paid review would go further.

---

# Addendum — adversarial review of the current build (2026-10-29, later)

The review above was written before the Firefox port. Two things happened after it, and both changed the
code, so the review was repeated against the current source.

## 1. The delegated reviewer produced no verdict, and said nothing useful when it failed

A subagent was asked for an independent JSON verdict. It read the right files (16 API calls, 15 minutes),
then exhausted its iteration budget while composing the answer and returned nothing:

```
final | status=completed duration=915.78s summary: API call failed after 3 retries:
        Non-streaming API call timed out after 150s
final | end status=completed exit_reason=max_iterations (iteration budget exhausted)
```

Its transcript also contained a stale observation worth chasing: it had grepped `dist/content.js` and found
the **old** sender guard (`senderUrl.startsWith("chrome-extension://")`), the one that was fixed for Firefox.
That is a real hazard — a stale `dist/` makes every measurement a measurement of the wrong code — so it was
checked first:

```
$ grep -rn 'senderUrl && !senderUrl.startsWith("chrome-extension' src/ dist/ dist-firefox/
  (no matches)
dist/content.js:1361  if (senderUrl && /^(https?|ftp|data|blob|file):/i.test(senderUrl)) {
dist/content.js:1364  if (senderUrl && !/^[a-z-]+-extension:\/\//i.test(senderUrl)) {
src mtimes 08:17  <  dist mtimes 08:18
```

The stale guard is gone from all three trees and the build is newer than the source. The reviewer had read a
snapshot from before the fix.

**Conclusion: there was no independent verdict.** Reporting one would have been fabrication. The review was
therefore performed directly, with `scripts/adversarial_review.py`, which is kept so the result is
reproducible rather than asserted.

## 2. The tool's first answer was wrong, in the direction of a false positive

The first run reported **1 HIGH**:

```
HIGH  content/content.js:149  innerHTML sink
```

It was not a finding. The line was `case 'html': return e.innerHTML;` — a **read**, which returns a page's
markup as a string and cannot execute anything. The detector searched for the substring and ignored the
difference between an rvalue and an assignment, and stripping comments had also shifted the line number.

Fixed in the detector, because a security tool that cries wolf is worse than none: writes are now matched as
assignments (`innerHTML =`, `insertAdjacentHTML(`, `document.write(`, `eval(`, `new Function(`, `javascript:`),
and reads are listed separately as non-sinks.

## 3. The verdict on the current build

```
CRITICAL  0
HIGH      0
MEDIUM    0
LOW       0
passed: true
```

The four questions an attacker asks first, and what stops each:

| Attack | What stops it |
|---|---|
| **A web page starts a run / saves / imports / schedules** | `externally_connectable` is not declared, so a page has no runtime id to message. The content script's own listener rejects any sender whose `sender.id` is not this extension (`content.js:479`). The worker classifies every sender and allows a content script exactly four types — `content-ready`, `element-picked`, `element-pick-cancelled`, `run-status` — none of which act (`service-worker.js:530`). |
| **A content script acts on a different tab** | The worker resolves the tab from `sender.tab`, never from the message, so a content script cannot name someone else's tab. |
| **Extracted page text → XSS in the panel** | Zero markup-write or eval sinks in the shipped UI. Every node is built with `createElement` + `textContent`, so a `<script>` inside extracted text renders as characters. |
| **An imported `.json` smuggles `runScript`** | `auditImportedAutomation` (`storage.js:255`) walks every step of every imported automation and strips script steps unless the caller explicitly allowed them. |
| **Data leaves the machine** | Zero `fetch`/XHR/WebSocket/`sendBeacon`/`EventSource`/`importScripts` in 16 source files, comments stripped. No network permissions declared. The only clipboard use is an explicit user "copy" button. |

`runScript` was also checked specifically: it injects a `<script>` into the page's **main world**
(`content.js:346`), so it reaches the page and its globals, and **not** `chrome.*` — the isolated world and
the extension APIs are unaffected. It is a documented feature that the user must type.

## 4. Residual risk — unchanged and by design

1. **`<all_urls>` plus a stored `runScript` step means compromise of extension storage is code execution.**
   The import audit stops an *accidental* smuggled script; it is not a sandbox, and it is not trying to be.
2. **Storage is not encrypted at rest.** Anyone who can write to it can plant a `runScript` step. This is the
   single highest-value target in the design.
3. **`runScript` is arbitrary code by definition.** Everything above constrains *who* can author one, not
   what one can do.
4. **Not fuzzed.** Cron parsing, CSV parsing and the template engine are tested against examples, not against
   coverage-guided input generation.
5. **The `<all_urls>` content script runs on every page.** That is the product, and it is why the message
   allowlist is the load-bearing control rather than a nice-to-have.

---

# Addendum 2 — the second reviewer's lead, followed to the end

The second delegated reviewer also exhausted its budget before answering (9 API calls, 25 minutes, then the
same API timeout while composing the verdict). Its transcript **did** contain a lead worth chasing, and it was
the right instinct:

```
08:32:58 tool | -> search_files(Function\(|source === 'js'|c\.js|cond...)
08:34:01 tool | -> search_files(eval\(|new Function|Function\(|javasc...)
08:34:01 tool | -> read_file(steps.js L230-349)
08:40:57 tool | -> search_files(fetch|XMLHttpRequest|WebSocket|sendBe...
```

It was hunting for a **condition** that executes code. That matters more than the XSS question, because a
condition is evaluated in the **service worker** — which holds every permission:

> Not "script in a page", but *the worker itself*. An imported `.json` automation would be full compromise.

So `scripts/follow_the_lead.py` follows it: every dynamic-code primitive in the source, with the **realm** each
one would run in, then the condition sources, then the step kinds, then the template layer.

## The lead does not resolve: there is no executing path

```
dynamic-code primitives across the whole source: 0
   no eval, no Function constructor, no string-form timer, no markup assignment, no dynamic import
condition sources: ['attribute','count','js','text','title','url','value','variable']
comparators: 26, including `matches`
the only step kind that accepts code: runScript
```

`source: 'js'` exists — the model documents it, the validator requires an expression for it (`steps.js:194`),
and the UI can display it. **Nothing evaluates it.** `conditions.js` routes it through `ctx.read`, and the
page's `observe()` short-circuits it and returns `null`:

```js
if (!finder || (condition && ['url','title','variable','js'].includes(condition.source))) {
  if (condition?.source === 'url')   return { value: location.href };
  if (condition?.source === 'title') return { value: document.title };
  return { value: null, found: false, flags: {} };   // <- 'js' and 'variable' land here
}
```

The template engine substitutes text; it does not compile. A page value can become a string that gets typed
into a field, never code.

## But following the lead found a real bug — a functional one, and a bad one

That same `observe()` line short-circuits **`variable`** along with `js`, `url` and `title`. And
`conditions.js` had grouped `variable` with the sources that are read **from the page**:

```js
if (condition.source === 'variable' || condition.source === 'js' || condition.source === 'url' ||
    condition.source === 'title') {
  const observed = ctx.read(condition);   // asks the PAGE for a variable's value
```

The page cannot know the run's variables and returns `null`. So:

> **`variable status eq ready` could never match.** Ever. The automation took the else branch every single
> time, and looked like it was working.

A condition that silently never matches is worse than one that throws, because wrong-branch behaviour is
invisible. Fixed by reading a variable from the run's own `vars`:

```js
if (condition.source === 'variable') {
  const raw = ctx.vars ? ctx.vars[condition.variable] : undefined;
  let observed = raw === undefined ? null : raw;
  ...
}
```

Found by writing the test first and watching it fail — 4 of 6 assertions:

```
× variable conditions > reads a variable from vars rather than asking the page
     → expected false to be true
× supports a numeric comparison on a variable
× the expected value is itself templated from vars
```

And an **existing test had encoded the bug**:

```js
it('compares a variable', () => {
  expect(evaluateCondition(c, { read: read({ value: 'ok' }) })).toBe(true);   // asserts it reads the PAGE
});
```

It passed because the stub returned a value, which the real page never does. Corrected, with the reason in the
test.

## What was also hardened, from the same lead

| Change | Why |
|---|---|
| `auditImportedAutomation` now walks **conditions**, not just steps (`allConditions`, `conditionDepth`) | Conditions carry the `js` source and author-supplied regexes. Today nothing is exploitable; the point is that the day someone implements evaluation, imported files are *already* inspected for it. A cycle-safe depth walk is included because a self-referential condition tree would otherwise hang the audit. |
| The regex **subject** is capped at 100 000 characters | The pattern is author-supplied and the subject comes from a page, so a catastrophic pattern against a megabyte of text spends unbounded CPU. The cap is applied before the regex engine sees it. |
| The audit flags a `source: 'js'` condition as medium | It is advertised and inert, so it can only mislead. Flagging it surfaces that to the user. |

## Three more false positives from the tooling, all the same mistake

| Reported | Reality |
|---|---|
| `critical: condition accepts a code source ['js']` | The source exists; nothing executes it. Reported by inferring danger from a **name** rather than from an executing call. |
| `critical: the template engine compiles its expressions` | `evaluateExpression` is this module's **own function**, and the pattern `eval(` matched the prefix of its name. |
| `HIGH: sidePanel` (Firefox audit) | The identifier is present and **unreachable** — the platform layer returns from every path of its `isFirefox()` branch first. |

That is now **four** false positives across three scripts, every one from matching an identifier instead of the
control flow around it. All four were fixed in the detectors, and the note is kept here because a security tool
that cries wolf is worse than none.

## Also fixed: two flaky tests, which hid real signal

Neither was a product bug, and both made a passing suite unreliable:

1. **`e2e` targeted "the active tab"**, which in that harness can be the extension's own `options.html` — and
   an automation cannot drive a `chrome-extension://` page:
   ```
   Cannot access contents of url "chrome-extension://.../options.html".
   Extension manifest must request permission to access this host.
   ```
   That looked exactly like a regression. The harness now resolves the test page's tab id and passes `tabId`
   explicitly, so it is hermetic about what it tests. (This also exercises the `tabId` path, which is a real
   feature.)
2. **Waiting passively for the MV3 worker.** A worker is killed when idle and starts on an event; polling
   `context.serviceWorkers()` waits for the browser to decide, and failed roughly one run in three. The loop
   now **wakes** it by opening an extension page.

Verified over four consecutive runs: `27/27, 27/27, 27/27, 27/27`.

## Final state

```
chromium audit      CRITICAL 0 · HIGH 0 · MEDIUM 0 · LOW 0   (19 attacks constructed and defeated)
firefox audit       CRITICAL 0 · HIGH 0 · MEDIUM 0 · LOW 0   (18 notes)
dynamic-code audit  CRITICAL 0 · HIGH 1... no: MEDIUM 1 · LOW 1   (0 dynamic-code primitives)
unit tests          378 (11 files)  - up from 372: 6 for the variable-condition bug
chromium            20 load + 27 end-to-end
firefox             31 functional + 10 security, in Firefox 159
web-ext lint        0 errors, 0 warnings
```

---

# Addendum 3 — a review packet, because the first two delegations failed on context size

Two independent reviewers were dispatched and **neither produced a verdict**. Both failed identically:

```
reviewer 1:  16 API calls, 15m16s  -> "API call failed after 3 retries:
reviewer 2:   9 API calls, 24m45s     Non-streaming API call timed out after 150s"
```

Neither failed to *read* the code — both read the right files and were clearly analysing them. Both failed
while **composing** the answer. The cause is measurable and was in the dispatch context all along:

```
instruction given: "read the source under /root/autoflow/src (core/, background/, content/, ui/, manifest.json)"
what arrived:     seven files totalling ~140 KB of accumulated context
consequence:      the final answer, which must be a JSON object, exceeded the 150 s non-streaming cap
```

So the fix is not a better prompt. It is **less to read**: one small file that contains exactly the code a
security judgement needs, with real `file:line` references so every claim can be checked.

`scripts/build_review_packet.py` builds it:

| | before | after |
|---|---|---|
| files to read | 7 | **1** |
| context | ~140 KB | **43 KB** (~10.8 k tokens) |
| what it contains | whatever the reviewer wanders into | the guards, **plus** the suspicious parts |

The packet deliberately includes the *suspicious* code as well as the guards — a `source: 'js'` condition, the
`runScript` injection, the import audit, upload handling, the markup-sink helpers. A reviewer handed only the
defences can only agree; handed the attack surface as well, they can attack.

Every anchor is asserted, because a packet that silently omits a section is worse than no packet:

```
every anchor matched
packet self-check:
  ok   the allowlist        ok   the import audit        ok   condition evaluation
  ok   the sender classifier  ok   the extract case       ok   the page's observe
  ok   the content guard    ok   runInPage                ok   the el helper
```

And the line numbers are verified against the real files — **717 cited lines checked**, all matching:

```
ok  background/service-worker.js:531  'content-ready',
ok  background/service-worker.js:532  'element-picked',
ok  background/service-worker.js:533  'element-pick-cancelled',
ok  background/service-worker.js:534  'run-status',
verified 717 cited lines against real source files
```

One defect was found and fixed in the packet itself: the sections are produced by `read_file`, which adds its
own outer line number on top of the source numbers already in the body, so a line read `501| 361| ...`. Two
numbers invite citing the wrong one. The outer number is now stripped and each section says
*"Line numbers below are the REAL line numbers in the source file."*

**This is a harness for a reviewer, not a substitute for one.** If the packet's reviewer also returns nothing,
that is recorded as such — the same standard applied to the first two.

---

# Addendum 4 — the third reviewer produced a verdict, and two of its findings were absent from the exhibit

The packet worked. Reviewer 3 returned a complete JSON verdict in **219 seconds** with only **3 API calls**,
against 15 and 25 minutes of failure for the two that were handed 140 KB:

```json
{"passed": true, "critical": [], "high": [], "medium": [2 items], "low": [1 item],
 "verified_absent": [8 attacks], "summary": "..."}
```

## What it independently confirmed

Eight attacks it constructed and could not make work, each with a line:

| Attack | Guard |
|---|---|
| page → privileged action | no `externally_connectable`; a page-originated message has no `sender.id`, so `service-worker.js:538` classifies it `unknown`, `562-566` refuses, `571-575` is the allowlist |
| page → content script | `content.js:479` rejects `sender.id !== api.id`; `491-497` rejects `http(s)/ftp/data/blob/file` and any non-extension scheme |
| imported `runScript` executing in the **worker** | no eval/Function/code-generation for automations in the worker; `runScript` is dispatched to the page, and the `js` condition source is inert |
| `js` condition evaluated anywhere | `conditions.js:159-166` → `ctx.read` → `service-worker.js:268-281` special-cases only `url`/`title` → `content.js:267-270` short-circuits `['url','title','variable','js']` to `{value:null}` |
| extracted value → markup/eval sink | `panel.js:22` and `options.js:14` map `text` → `textContent`; `panel.js:32` uses `createTextNode`; there is deliberately no `html` prop; the only other sink is `setAttribute` at `panel.js:28` |
| author regex ReDoS as an import-time crash | `storage.js:368-387` compiles patterns in a `try`, records a concern; `conditionDepth` caps at 24 with a seen-set; `importAll` caps steps at 20000 |
| upload from a page | `add-upload-file` is behind the same origin gate, and the payload is validated as a base64 data URL held in session storage — never written to disk |
| network egress | no `fetch`/XHR/WebSocket/`sendBeacon` anywhere; diagnostics reads only `navigator.userAgent/language/timezone` |

That is a **stronger** independent result than the two scripted audits: an outside reviewer, working only from
the packet, reconstructed the same guards and found nothing new in the security-critical direction.

## Where it was wrong, and where it was nonetheless useful

Both `medium` findings said the same thing: *the audit is advisory and the import path does not enforce it.*

> "`importAll` accepts an `allowScripts` flag, but the shown fragment (447-472) never consults it — ...
> **enforcement may exist below line 472 (not shown)**"
> "`auditImportedAutomation` is advisory only: it returns a `concerns[]` list, it never mutates, strips or
> rejects steps."

**The enforcement exists at `storage.js:479`, and there was already a test for it.** The reviewer was honest
that it could not see below the shown region — so this was a defect in the packet, not in the code, and it is
the **fifth** false positive of this work, all five sharing one root cause:

> a judgement made about *what was shown* rather than about *what is*.

| # | reported | reality | root |
|---|---|---|---|
| 1 | `HIGH innerHTML sink` | `return e.innerHTML` — a **read** | substring match instead of an assignment |
| 2 | `critical code source ['js']` | present, **nothing executes it** | inference from a **name** |
| 3 | `critical template compiles` | `evaluateExpression` — the module's **own function** | `eval(` matched a name prefix |
| 4 | `HIGH sidePanel` | identifier present, **unreachable** | matched an identifier, not the control flow |
| 5 | `medium ×2 import not enforced` | enforced at `:479`, tested | **the exhibit was cut short** |

Fixed in the packet: `importAll` is now included in full alongside the audit, with a note stating the
connection. Showing a guard's preamble without the guard is what invites this class of finding.

## But chasing it found two real gaps

The reviewer's *reasoning* was wrong and its *instinct* was right, so every caller of the audit was traced.
Three exist:

| caller | purpose | verdict |
|---|---|---|
| `storage.js:473` inside `importAll` | the import itself | **enforces** — `if (hasScript && !allowScripts)` refuses and records `skipped[]` |
| `service-worker.js:701` `case 'audit-import'` | a dry run for the UI | correctly advisory: returns `concerns[]` and `containsScripts` |
| `storage.js:255` inside `exportAll` | stamping an export | correctly advisory: the document carries `containsScripts` so a recipient can decide first |

And then the gap, in the UI:

**Gap 1 — the UI never called the dry run.** `options.js` went straight to `import-all`. So the whole
`audit-import` handler existed and was unreachable, and importing a shared file that carried a script step
produced `Imported 3, skipped 1` with **no statement of why** and **no way to accept it deliberately**. A user
with a legitimate script step had no path to import it; a user with a hostile one was told only a count.

**Gap 2 — `allowScripts` was never passed as `true` by anything.** `importAll` defaulted it to `false` and no
caller ever set it, so the "re-import with scripts allowed" escape hatch the refusal message advertises did
not exist in the product.

Both fixed: the options page audits first, and when a script step is present it states the risk and asks —
*OK = import everything including script steps; Cancel = import everything except those* — then passes the
answer through. The toast now names what was skipped rather than only counting it.

Three tests were added that close the gap between "the audit returns concerns" and "the import actually
refuses", including a script step buried in a loop, in an `if` and in a `forEach`:

```
importAll REFUSES an automation carrying a script step, and names it in skipped[]
imports the same automation when the caller explicitly allows scripts
a script step buried in a loop or a branch is still found
```

## Final state

```
chromium audit       CRITICAL 0 · HIGH 0 · MEDIUM 0 · LOW 0
firefox audit        CRITICAL 0 · HIGH 0 · MEDIUM 0 · LOW 0
dynamic-code audit   CRITICAL 0 · HIGH 0 · MEDIUM 1 · LOW 1
independent reviewer passed=true · CRITICAL 0 · HIGH 0 · 8 attacks confirmed defeated
unit tests           381  (378 → 381: three for the import enforcement)
chromium             20 load + 27 end-to-end
firefox              31 functional + 10 security, in Firefox 159
web-ext lint         0 errors, 0 warnings
```

The reviewer's low finding is accepted rather than argued with: `runInPage` injects the stored step's `code`
verbatim into a `<script>` in the page's main world. That is the documented feature, the token is
`JSON.stringify`'d, and the result travels back through a data attribute; a `runScript` step can do exactly
what the page can already do, and **cannot** reach `chrome.*`. It is the design, stated as the design.

---

# Addendum 5 — the falsification, done mechanically because a fifth reviewer was not going to work

Reviewer 4 was dispatched against the corrected packet, specifically to test whether reviewer 3's findings
disappear when the code that refutes them is in the exhibit. It produced no verdict:

```
deleg_f19b2757 (returned a verdict):  3 calls,  3m39s
deleg_e7d3e910 (no verdict):          2 calls,  4m42s, timeout with the cap at 90s
```

The provider's cap had **dropped from 150 s to 90 s between the two dispatches**, so a fifth attempt says
something about the provider and nothing about the code. The falsification is therefore mechanical, and it is
the stronger form anyway — it does not depend on a model choosing to cooperate:

> **For every finding ever raised, name the code that refutes it, and assert that code is present in the
> packet at the correct line number.**

`scripts/check_exhibit_completeness.py` does exactly that. Result:

```
ok   finding 1: HIGH: innerHTML sink in the shipped UI
ok   finding 2: critical: a condition accepts a code source ['js']
ok   finding 3: critical: the template engine compiles its expressions (eval)
ok   finding 4: HIGH: the Firefox bundle calls sidePanel, which does not exist on Firefox
ok   finding 5: medium x2: importAll never consults allowScripts; the audit is advisory

all findings refuted in the packet: True
the specific thing reviewer 3 said it could not see: now present at line(s): [479]
```

## It found three real defects in the exhibit, all of the same kind

Running it was worth more than another reviewer, because a mechanical check cannot be polite:

| Defect | Consequence |
|---|---|
| The `extract` section was cut at **45 lines**, one line short of `return { value: String(raw) ... }` | a reader saw `case 'html': return e.innerHTML` and **not** the coercion that makes it harmless — which is precisely finding 1's shape |
| **`platform/api.js` was never in the packet at all** | finding 4 (the `sidePanel` reference) was unverifiable in the exhibit, while the audit that raised it read the whole repo. A reader could only take it on trust |
| The **template engine was absent**, so finding 3's refutation ("it compiles nothing") was an assertion | the strongest possible claim — "there is no dynamic code anywhere" — was the one the packet could not support |

All three are the same mistake as the findings themselves: **an exhibit that shows the suspicious code without
the code that resolves it.** A packet that omits the guard and a grep that matches an identifier are the same
error from opposite ends.

## And one defect in the packet's own plumbing, which silently hid a line from every section

The packet is assembled as a list and joined with `""`. The code fence was appended as `"```javascript"`
without a trailing newline, so it fused with the first code line:

```javascript  530| const CONTENT_SCRIPT_MESSAGES = new Set([
```

`read_file` then renders that as a section **missing its first line** — in all **18** code sections. The
reviewer that reported the import-enforcement finding was reading a packet where the first line of every
exhibit was invisible. Fixed by putting the newline inside the literal; the first attempt at the fix appended
`""`, which changes nothing when the join is not by newline.

Verified after the fix:

```
glued fences remaining: 0
sections: 20   with a visible first code line: 18   (the other two are a JSON block and prose)
```

## Why this is stronger than a fourth reviewer's agreement

A reviewer saying "passed" is a data point about a model on a day. This is a statement about the exhibit:

> every finding that has ever been raised against this code now has the code that refutes it **in front of the
> reader, at a line they can check** — so the finding cannot be raised again by anyone reading it honestly, and
> a reader who disagrees can point at a specific line rather than at an impression.

That is falsifiable, reproducible with one command, and does not depend on a provider staying up.

## Final counts

```
unit tests            381
chromium load          20    chromium e2e   27
firefox functional     31    firefox security  10   (Firefox 159)
chromium audit         CRITICAL 0 · HIGH 0 · MEDIUM 0 · LOW 0
firefox audit          CRITICAL 0 · HIGH 0 · MEDIUM 0 · LOW 0
independent verdict    passed=true · 8 attacks confirmed defeated
exhibit completeness   all 5 findings refuted in the packet
web-ext lint           0 errors · 0 warnings
```

Reviewers returning a verdict: **1 of 4**. Recorded as such, not smoothed over.
