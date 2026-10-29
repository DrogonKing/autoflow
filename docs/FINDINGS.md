# AutoFlow — build notes and findings

Date: 2026-10-29. Built at `/root/autoflow`.

## What it is

A MV3 browser extension: auto-click, fill, record and **schedule** browser automations. Chrome and Edge.

Built after downloading and analysing the reference extension (`Auto Clicker - AutoFill`, v5.4.1) with
REA, because the store description is marketing and the code is the contract.

## What the reference extension actually does

Read from its own `_locales/en/messages.json`, its manifest and its 502 KB `background.js`:

- **v5.4.1, MV3, 331 KB, 23 locales.** Publisher Dhruv-Techapps.
- Feature vocabulary: `@ACTION_CONDITION`, `@BATCH__TITLE` (Loop), `@SCHEDULE`, `@REPEAT`, `@RECHECK`,
  `@GOTO`, `@TABS__TITLE`, `@USER_SCRIPT__TITLE`, `@SIDE_PANEL__RECORDING_TAB`, Drive backup, a DevTools
  recorder, and an "Ask AI" panel.
- Permissions: `storage`, `notifications`, `contextMenus`, `activeTab`, `identity`, `alarms`,
  `unlimitedStorage`, `scripting`, `userScripts`, `webNavigation`, `sidePanel` + `http://*/*`,
  `https://*/*`.
- **Telemetry:** `google-analytics.com/mp/collect`, `otel.getautoclicker.com`, Firebase, and
  `localhost:4318` (OpenTelemetry).
- **Paid gating:** `subscription_feature_blocked` and a "Subscription Required" string.
- APIs that made a literal multi-browser port impossible: `chrome.sidePanel` and `chrome.userScripts`
  exist only in Chromium; `chrome.identity` is partial on Firefox and absent on Safari; `chrome.devtools`
  is absent on Safari. Its manifest also uses `world: "MAIN"` in a content script, which Firefox handles
  differently. Safari additionally needs a converter run on macOS with Xcode and an Apple developer
  account.

Per the user's instruction — every feature matters more than browser breadth — the target is Chromium
with the full feature set.

## What is implemented

32 step kinds, 10 element-finder strategies with a recorded fallback chain, 7 schedule kinds (once,
interval, daily, weekly, monthly, cron, manual), CSV-driven runs, templates with variables and random
functions, loops/branches/break/continue, the element picker, a side panel with a live schedule preview,
an options page with backup/import/export and diagnostics.

Everything the reference advertises except the cloud and AI parts: no Drive backup, no "Ask AI", no
subscription gate, no telemetry. There is no network code in the extension at all.

## Verification

```
314 unit tests          9 files, all platform-independent logic
20  load/UI checks      the extension loaded in a real Chromium: worker, panel, options, alarms
26  end-to-end checks   a real automation driving a real HTTP page, plus a scheduled run firing itself
```

Instrumentation the tests rely on:

- a **DOM marker** (`data-autoflow-content`) because a content script runs in an isolated world, so the
  page cannot see its `chrome` object
- messages sent from an **extension page**, never from the worker — a service worker's own
  `runtime.sendMessage` does not reach its own `onMessage` listener
- the Chromium already present at `/root/.cache/ms-playwright/chromium-1208` rather than a fresh download

## Bugs found, with the class of bug each represents

1. **A failed step was recorded as a success.** Page-side steps answer with an envelope
   (`{ok:true,result}` / `{ok:false,error}`) and the host passed it straight through. A missing element, a
   rejected fill and a timed-out `waitFor` were all recorded as `step-ok` and the run reported
   `finished`. Silently wrong is the worst kind.
2. **Every extracted value was `[object Object]`** — the same mistake seen from the other side: `extract`
   read the envelope instead of `result.value`.
3. **`observe()` destructured `elements` from a function returning `element`**, so every condition reported
   "not found" and a count condition threw on `el.count`.
4. **One malformed stored record hid every automation**, because the list mapped over all of them with no
   guard.
5. **One invalid schedule broke the status of all the others** — `describeSchedule` validates, and it sat
   outside the `try` that was protecting `nextRun`, so the whole call threw.
6. **A click fired two handlers.** The pointer sequence dispatched a synthetic `click` and the
   compatibility `el.click()` added a second: a form submitted twice. Fixed by making the source of a
   click depend on the element — a link needs the element's own click (a synthetic one does not navigate),
   anything else gets the synthetic one (it carries the real button and detail).
7. **`ctypes`-style layout assumptions** are not the problem here, but the same class: `setNativeValue`
   looked for "a setter different from the instance's", which is the wrong test. React's controlled inputs
   need the *prototype's* setter, found by walking the chain.

## Environment facts worth keeping

- The test Chromium is at `/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`; the cache is
  shared and must not be deleted. A newer Playwright wants a different build, so `executablePath` is set
  explicitly.
- `new win.MouseEvent(...)` with `view: window` throws in jsdom ("member view is not of type Window")
  because its `window` is a plain object. The code constructs events with a cached fallback that drops
  `view`.
- jsdom computes no layout, so `getBoundingClientRect()` is all zeros there. Treating a zero box as
  "invisible" hides the entire page under test; the visibility check detects whether layout exists first.

## Packaging

`release/autoflow.zip` (53 KB, 14 files) and `release/autoflow-source.zip` (135 KB, 37 files).

The extension zip has `manifest.json` at its **root**, which is asserted by the packaging script — zipping
the project folder instead puts it under `dist/` and Chrome then reports only "Manifest file is missing or
unreadable".

## Limits, stated plainly

- Chromium only. Firefox needs two substitutions and is not tested here. Safari needs macOS and an Apple
  account.
- `runScript` executes in the page's world, not the extension's.
- A background tab may be throttled by Chrome, so an individual `wait` can overshoot. Deadlines are
  recomputed from elapsed time, so a run does not drift.
- The picker records a chain, not a guarantee: a site that rebuilds its DOM every render can still defeat
  it.
