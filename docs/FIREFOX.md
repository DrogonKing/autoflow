# Firefox build — what was different, and what broke

Date: 2026-10-29. Verified against **Firefox 159** in this environment, driven by geckodriver over
WebDriver, with Mozilla's own `web-ext lint` reporting **0 errors and 0 warnings**.

**This is not a repackage.** Five real bugs were found by running it, three of which would have made the
extension look broken on Firefox with no error message. They are listed in §3.

---

## 1. The four manifest differences

Firefox and Chromium want different manifests for the same source. Each is a hard failure if ignored, and
`web-ext lint` names them (`ADDON_ID_REQUIRED`, `BACKGROUND_SERVICE_WORKER_NOFALLBACK`, invalid permission,
missing `data_collection_permissions`).

| | Chromium | Firefox |
|---|---|---|
| Background | `background.service_worker`, `type: module` | `background.scripts`, `type: module` — a service worker key is **ignored** |
| Add-on id | not needed | **required** in MV3: `browser_specific_settings.gecko.id` |
| Side surface | `sidePanel` permission + `side_panel` key | `sidebar_action` key; `sidePanel` is **not** a valid permission |
| Consent | none | `browser_specific_settings.gecko.data_collection_permissions` is **required** |
| Min version | `minimum_chrome_version` | `strict_min_version: 140.0` — see §4 for why not 115 |

`scripts/build-firefox.mjs` derives the Firefox manifest from the Chromium one so the two cannot drift, then
asserts that every file it references exists.

---

## 2. The API layer (`src/platform/api.js`)

Chromium's `chrome.*` returns Promises in MV3 and also accepts callbacks. Firefox's `chrome.*` is
callback-only, and `browser.*` is the Promise one. Two ways to get this wrong, both silent:

- `await chrome.alarms.getAll()` → `undefined` on Firefox. Every alarm check then sees "no alarms".
- `chrome.runtime.sendMessage(msg, cb)` on Firefox → the callback is not reached the way Chromium does it.

So every API call in the shipped code goes through one module, which is promise-based and has no callbacks
above it. A test asserts that no `chrome.*` reference remains outside that module.

### The subtle bug in the layer itself

The first version called the method **with** a callback and resolved on whichever of the callback or the
returned promise came first. On Firefox that is wrong in a way that is hard to see:

```
browser.storage.local.get('automations', myCallback)
```

Firefox does not treat the second argument as a callback for `storage.get`. It is the **default values
object**. So the call resolved immediately with:

```js
{ automations: <the callback function itself> }
```

The write had succeeded. The read returned a function where a list should be. A saved automation never
appeared, and the UI looked like storage was not saving at all. Measured symptom, before the fix:

```
storage probe: {"wrote":true, "listedAfterSave":0, "saveResponse":{"ok":true,...}}
```

The fix: call **without** the callback first. If a promise comes back, that is the reply. Only if the call
returns nothing usable is the callback form used. A synchronous throw from the first attempt is not
reported as the failure — a callback-only implementation throws when its callback is missing, and that is
exactly the case the second attempt handles.

---

## 3. Bugs found by running it, not by reading about it

### B1 — the sender guard rejected the extension's own worker 🔴

The content script refused any message whose `sender.url` did not start with `chrome-extension://`. Firefox's
scheme is `moz-extension://`, so the guard rejected the background page and **every page action failed**:

```
the page gave no answer for the click step
```

Fixed by testing the thing being guarded rather than a scheme literal: reject `http(s)`/`data`/`blob`/`file`
senders, accept any `*-extension://` scheme. The background side compares against `runtime.getURL('')`,
which carries the right scheme on each browser.

This is the same class of mistake as the earlier sender-validation bug in the Chromium work: a check written
against an assumed shape instead of a measured one.

### B2 — `runScript` never returned its value 🔴

A `<div>` "holder" was created to carry the result and then **never appended to the document**. The injected
script looks the holder up with `getElementById`, found nothing, and every `runScript` step returned:

```
{ note: 'the script produced no synchronous result' }
```

The step reported success and produced nothing. Unit tests did not cover the return path; a run against a
real page did, immediately.

### B3 — a function could not cross the message port 🔴

`extract` reads a value out of a page. On a plain `<div>` that is a string, but the reply also carries the
element's other properties, and a page can define any of them as a function. A runtime message is
structured-cloned, and **a function cannot be cloned**:

- Chromium drops the property silently — the field just goes missing.
- Firefox throws `Function object could not be cloned` and the whole step fails.

Fixed at both ends: `extract` now always coerces to a string, and `src/platform/serialise.js` makes a reply
safe to send, reporting what it had to sanitise so the cause is not hidden.

### B4 — two test-harness assumptions that were wrong (not product bugs)

Recorded because they cost time and would cost it again:

- **geckodriver tracks ONE browsing context.** `window/handles` returns several, but `GET /window` reports
  the same handle for all of them. Measured: `current == panel == page`. So the test never navigates away
  from the extension page; test pages are opened in the background by the browser and read through the
  extension's own `runScript`.
- **A temporary add-on is served from `moz-extension://<random-UUID>/`**, not from its add-on id. Building
  the URL from the id loads nothing, the page has no `browser` object, and it reads as a broken extension.
  The real URL comes from `WebExtensionPolicy.getByID(id).getURL('')` in the chrome context.

Also needed, and each was a distinct failure:
`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` for the chrome context; `POST /session/<id>/execute/sync` (the bare
`/execute` path answers 405); and the driver refuses to navigate to `moz-extension://` at all, so the browser
opens that tab itself.

---

## 4. Why `strict_min_version` is 140 and not 115

`data_collection_permissions` is required for a new add-on and **arrived in Firefox 140**. Declaring 115
while that key is present produces `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`: the key would be ignored on
115–139, so the consent declaration a reviewer looks for would silently not exist. 140 is the oldest
version on which this manifest means what it says.

Firefox for Android is explicitly not a target (`gecko_android.strict_min_version: 142`): the UI is a
`sidebar_action`, and Firefox for Android has no sidebar, so the panel would be unreachable. Saying so beats
leaving a warning that looks like an oversight.

---

## 5. Verification

```
372  unit tests                      10 files
  0  web-ext lint errors              Mozilla's own linter
  0  web-ext lint warnings
 20  Chromium load checks
 26  Chromium end-to-end checks       a real page, a real scheduled run
 31  Firefox checks                   Firefox 159 via WebDriver
```

The Firefox run is not a smoke test. It asserts, in a real browser:

- the extension installs and its MV3 event page answers a message (`background.scripts` works)
- `browser.*` is present and promise-based in an extension page
- the manifest declares `scripts` and **not** `service_worker`
- `sidebarAction` exists and `sidePanel` does not
- storage round-trips a saved automation (the B-fix above)
- `alarms` can be created and read
- the scheduler arms a real alarm and describes it
- a content script injects into a real page and answers the extension
- an automation of 8 steps runs to completion: click, fill, check, select, two extracts, `runScript`,
  `waitFor`
- the page's **own** event listeners fired — `["click:go","input:name","change:terms","change:plan"]` —
  which is the difference between "we dispatched an event" and "the page believed a user did it"
- the extracted values reached the run variables (`clicks=1`, `nameValue=from firefox`)
- a scheduled automation **fired by itself** within 12 seconds

---

## 6. Installing

**Firefox, permanent:** the zip must be signed by Mozilla (addons.mozilla.org) — an unsigned build cannot
be installed permanently, and that is a Mozilla policy, not a limitation of this code.

**Firefox, now:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
`dist-firefox/manifest.json`. Temporary add-ons are removed when Firefox closes, which is the right shape for
testing but not for daily use.

**Chromium:** `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`.

---

## 7. What is still Chromium-only or untested

| Item | State |
|---|---|
| Safari | Not attempted. Needs macOS, Xcode, an Apple developer account, and a converter run. |
| Firefox for Android | Deliberately excluded: no sidebar, so the panel is unreachable. |
| `tabs.goBack` / `goForward` | **Not available in Firefox.** The step reports `false` and the trace records "history navigation is not available in this browser" rather than failing the run. |
| The `sidebar_action` open behaviour | Registered and reported by the test; not exercised by a click, because headless Firefox has no toolbar. |
| Key shortcuts | `commands` is declared for both; only Chromium's are exercised. |
| Persistent install | Requires Mozilla signing. |
---

# Security review of the Firefox build

The Firefox build comes from the same source as the Chromium one, so the privilege boundary, the import
audit, the absence of markup sinks and the zero-network property **carry over unchanged**. What does *not*
carry over is everything outside the shared code: the manifest, the extension scheme, and the permission
model. Each of those is a place where a guard can silently stop applying — and a guard that stops applying
fails **open**: the code still runs, it just no longer checks anything.

Audited in two layers, because neither alone is enough:

- `scripts/firefox_security_audit.py` — reads the **built** artefacts (`dist-firefox/`), not the source
- `scripts/firefox-security-test.mjs` — asserts the same questions **in a running Firefox 159**

## The manifest diff, and why each difference matters

| Key | Chromium | Firefox | Security impact |
|---|---|---|---|
| `background` | `service_worker` | `scripts` | A service worker and an event page have different lifetimes. **Only** `scripts` on Firefox: declaring both would make the manifest state a model that is not the one running. |
| `permissions` | 7, including `sidePanel` | 6, `sidePanel` removed | `sidePanel` is not a valid Firefox permission. An over-declared permission widens the install prompt for no benefit. |
| `side_panel` / `sidebar_action` | `side_panel` | `sidebar_action` | Not a weakening — the side surface has a different name. Verified present, or the UI would be unreachable. |
| `browser_specific_settings.gecko.id` | absent | `autoflow@drogon.site` | Required in MV3, and a stable id pins an update to the same install rather than silently creating a second copy. |
| `data_collection_permissions` | absent | `{required:["none"], optional:[]}` | **A formal declaration to Mozilla and to the user.** If false, it is worse than no declaration — see the runtime test below. |
| `strict_min_version` | n/a | `140.0` | 140 is where that consent key arrived. Declaring 115 would make the declaration silently absent on 115–139. |

`host_permissions` is `<all_urls>` on **both**, unchanged — required by the product, and the reason the
message allowlist is the load-bearing control rather than a nicety.

## The Firefox-specific failure mode: the scheme

`chrome-extension://` is correct on Chromium and **fatal** on Firefox, where the scheme is
`moz-extension://`. A guard that compares against the literal rejects the extension's *own* pages. This was
already one real bug during the port (every page action failed with "the page gave no answer"), so the audit
checks the shipped bundle rather than trusting the source:

```
$ grep -c 'chrome-extension://' dist-firefox/*.js
    8 occurrences, all inspected
    → comments and URL construction only; zero identity comparisons
```

And the two guards that *are* identity comparisons are written against the property, not the spelling:

- `content.js` rejects `http(s)|ftp|data|blob|file` senders and accepts any `*-extension://` scheme
- `background.js` compares against `runtime.getURL('')`, which carries the right scheme on each browser

Also checked: **zero direct `chrome.*` calls** in the Firefox bundle. On Firefox `chrome.*` is callback-only,
so a promise-style call returns `undefined` and any check depending on the value silently passes.

## The `data_collection_permissions: none` claim, tested rather than asserted

A manifest declaration is a promise, and a promise is worth exactly as much as the test behind it. So the
runtime test starts an HTTP server, runs a full automation against a page on it, and counts every request the
server receives:

```
the run produced ZERO requests to the probe origin     0 during the run
probe server saw 2 requests in total:
   GET /              ← the test page load itself
   GET /favicon.ico   ← the browser asking for a favicon
```

Zero `fetch`/XHR/WebSocket/`sendBeacon`/`EventSource`/`importScripts`/geolocation/clipboard-read in any of
the four bundle files, comments stripped.

**The honest limit of that declaration**, stated rather than implied: `runScript` runs in the page's main
world, where `fetch` exists *for the script the user wrote*. The extension makes no request; a script step
could. That is exactly why `auditImportedAutomation` strips script steps from an imported file by default.

## Privilege boundary, verified in the running browser

The strongest position an attacker can occupy without already owning the machine is an **extension page**.
From there, the ten privileged message types all answer — which is correct, that is the legitimate path:

```
start-run · save-automation · delete-automation · export-all · save-settings
schedule-one · add-upload-file · read-file-for-upload · list-runs · ...
      → 10/10 answered
```

The control is that a **content script** — present on every page the user visits — cannot reach them. The
worker classifies the sender and allows a content script exactly four types:

```
content-ready · element-picked · element-pick-cancelled · run-status
```

Two refusals worth quoting because they show the guards actually firing rather than being decorative:

```
read-file-for-upload  →  "refusing a file name with a path component"    ← path traversal blocked
import-automations    →  "unknown message type"                          ← not in the content allowlist
```

And an unknown type is refused by name rather than accepted:

```
definitely-not-a-real-type  →  {"ok":false,"error":"unknown message type definitely-not-a-real-type"}
```

## `runScript` cannot escape into the extension

The single most important question about a feature that injects code. Measured inside the page's main world:

```json
{"hasBrowser":"undefined","hasChrome":"undefined","hasRuntime":false}
```

The page world has no namespace at all, so a script step can drive the page and **cannot** call a single
extension API. The isolated world and every `chrome.*`/`browser.*` call remain out of reach.

## Result

```
CRITICAL  0
HIGH      0
MEDIUM    0
LOW       0
passed: true

static audit  18 notes
runtime test  10/10 checks passed in Firefox 159
```

## Two false positives the tooling produced, and why they are recorded

Both were in the audit, not the product, and both had the same root cause: **matching an identifier instead
of the control flow around it.**

1. **`sidePanel sink, HIGH`** — the identifier is present in the bundle at `background.js:1256` and `:1281`,
   but unreachable: the platform layer branches on `isFirefox()` and returns from every path inside that
   branch before touching it. Fixed by requiring the guard's absence, not the identifier's presence.
2. **`innerHTML sink, HIGH`** (Chromium audit) — the line was `return e.innerHTML`, a *read* that returns a
   page's markup as a string. Fixed by matching assignments (`innerHTML =`, `insertAdjacentHTML(`,
   `document.write(`, `eval(`, `new Function(`) and listing reads separately.

A security tool that cries wolf is worse than none, so both were fixed rather than noted and ignored. The
same discipline applies to the earlier delegated review: it produced no verdict, and no verdict is what was
reported.
