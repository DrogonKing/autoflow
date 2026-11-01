> ## ⚠️ BETA — each time now finds its own page
>
> Your log showed the two faults precisely. Both are fixed. Verified in a controlled browser, **not against a real
> trading site yet**.

## Your report

> «سه تا زمان هرکدوم سه تا pick فقط زمان اولیه pickهاش فعال شد»

Your own export said why, exactly:

```
basic       FIRED   tab-from-memory  …/autoflow-test-field (4).html     ← ran
basic-new1  step-error   "this automation has never had an element picked in it, so a scheduled run has no page"
basic-new2  step-error   (same)
```

and `lastPickPages` held **one** entry, `basic`.

## ۱. Every pick filed its page under the first time

The pick handler attached the page to `state.basic.id`, and that is **always** `basic` — so a pick made in time two or
three recorded its page against time one. Each time becomes its own automation, so each needs its own remembered page.
The page now belongs to the time whose point was picked:

```
before:  lastPickPages: {"basic": "http://…/"}
after:   lastPickPages: {"basic": "http://…/", "basic-new1": "http://…/", "basic-new2": "http://…/"}
```

## ۲. A failing time fired three times in two seconds

From your log:

```
18:45:05.517  FIRED       basic-new1
18:45:05.528  RE-ARMED    basic-new1  for 18:45:07.000
18:45:06.534  FIRED       basic-new1      ← again
18:45:07.551  FIRED       basic-new1      ← and again
```

The alarm is armed **1500 ms before** its target (that is what makes the sub-second timing work), so re-arming from
"the target + 1 ms" produced an alarm whose moment was already in the past — and Chrome fires a past alarm immediately.
Three firings, and the very second the target was aiming at got consumed.

It now asks from a point that leaves room for that margin, so the re-arm lands in the future. Measured after the fix:
**one firing** where there were three.

## New tests, because the old ones could not see either fault

```
per-time-pick-page-test   8/8    three times, each picked with a MOUSE, each with its own page
alarm-storm-live-test     2/2    a failing run fires once, not three times in two seconds
```

`three-times-test` passed throughout this — because it typed selectors by hand, and the page is only recorded by a real
**Pick**. That is why the fault survived a release: the test covered the feature without covering the path.

## Also worth knowing

An alarm set for less than ~30 seconds ahead fires **immediately** in Chrome — a platform behaviour, not a bug. If you
set a time a few seconds away for testing, expect it to go at once; a real target is minutes away.

## Verified

```
per-time-pick-page 8/8 · alarm-storm-live 2/2
previous suites still green: three-times 11/11, pick-digits 21/21, remove-time 15/15
776 unit tests, 39 files
36 browser suites green, 0 red, 1 known load flake, 1 needing a window manager
```

## Install

**Chrome / Edge / Brave / Opera** — download `autoflow-chrome.zip`, unpack it, then
`chrome://extensions` → enable Developer mode → **Load unpacked** → pick the unpacked folder.

**Firefox** — download `autoflow-firefox.zip`, unpack it, then `about:debugging#/runtime/this-firefox` → **Load
Temporary Add-on** → pick `manifest.json` inside the folder.

**Lite builds** (`autoflow-chrome-lite.zip`, `autoflow-firefox-lite.zip`) — the same release with the Basic tab only.
They install BESIDE the full build and are named "… Lite" so the two are distinguishable.

## If you are upgrading

Take a backup first, on the Data tab. Automations restored from a backup arrive **disabled** on purpose.