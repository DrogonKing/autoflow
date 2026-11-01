> ## ⚠️ BETA — several times, each with its own points
>
> This build adds a feature that changes the shape of the Basic tab. Everything below is verified in a controlled
> browser, **not against a real trading site yet**.
>
> - the Basic tab still shows ONE time and its points, as before
> - under "+ Add a point" there is now "+ New time"
> - each time keeps its own points, and each is a separate automation with its own alarm
>
> Please test with a target you do not mind missing. If anything misbehaves, the previous stable release is still
> available.

## What is new in 1.31.0

**Several times, each with its own points.** The Basic tab used to hold one time and all the points. It now holds a list
of times, each with the points that belong to it:

```
09:00:00.000   ← open, with its own points
09:01:00.000   ← one press of "+ New time", starts with one empty point
```

Each time is **one automation behind the scenes**, because a schedule is one alarm and one alarm is one automation. The
run engine, the history, the run lock and the "did it arm?" diagnostics are all untouched.

The list is ordered by **when each time next fires**, not by the clock face, so 23:50 appears before 00:10.

## Fixed in this build

Two genuine faults that the existing suites caught, both of which would have broken the panel for everyone:

- **A pick landed but the selector stayed empty.** The points moved into the per-time lists, and the pick listener was
  still searching the old one. `__pickDebug` reported `found: true` while writing to an orphaned object — the pick was
  applied, to the wrong copy. Found by `time-survives-pick-test`.
- **A save with no usable point reported success.** The single-time path filtered empty points before saving; the new
  path did not, so `steps.length` was 1 instead of 0 and the "at least one point" refusal never fired. Found by
  `save-button-test`.

## The import check was repaired

`tests/worker-imports.test.js` had four separate holes, and between them two real `ReferenceError`s reached the browser
and blanked the panel:

| hole | effect |
|---|---|
| `Map.has()` instead of `.get()` | the "declared here" guard was never true |
| `relative()` called, never defined | the test threw the first time it found anything |
| every word inside a string counted as declared | a missing import was invisible if the name appeared in UI text |
| the object-key rule matched `${` | a call inside a template interpolation was never seen |
| the assertion named three historical identifiers | everything else was printed and **passed** |

It is now `scripts/check-imports.mjs`, run directly in CI as well as through the suite, and proven by four cases: clean,
and each fault reintroduced.

## Verified

```
772 unit tests · 39 files
33 browser suites green · 0 red · 1 known load flake · 1 needs a window manager
ui-basic 25/25 · events-ui 9/9 · time-survives-pick 6/6 · pick-confirm 10/10
save-button 12/12 · e2e 28/28 · firefox 31/31 · lite-build 4/4
```

## Install

**Chrome / Edge / Brave / Opera** — download `autoflow-chrome.zip`, unpack it, then `chrome://extensions` → enable
Developer mode → **Load unpacked** → pick the unpacked folder.

**Firefox** — download `autoflow-firefox.zip`, unpack it, then `about:debugging#/runtime/this-firefox` → **Load
Temporary Add-on** → pick `manifest.json` inside the folder.

**Lite builds** (`autoflow-chrome-lite.zip`, `autoflow-firefox-lite.zip`) — the same release with the Basic tab only.
They install BESIDE the full build and are named "… Lite" so the two are distinguishable in `chrome://extensions`.

## If you are upgrading

Take a backup first, on the Data tab. Automations restored from a backup arrive **disabled** on purpose, so a restore
cannot start clicking before you have looked at it.