> ## ⚠️ BETA — the second pick no longer disappears
>
> **This one is my fault, and it took three attempts.** The auto-save I added in 1.32.0 introduced a re-seed that
> deleted work you had not saved yet. All three of its shapes are described below so you know what to watch for.

## What you reported

> «چرا وقتی pick دوم رو میزنم و تارگت رو انتخاب میکنم کلا pick دوم حذف میشه و مینویسه saved»

Reproduced exactly, and the cause was the save path I added last release — not the Pick machinery.

## Why it happened

The form keeps the times and points you are editing in a **working copy**, and after a save I re-seeded that copy from
storage. Three versions of that re-seed, three faults:

| the re-seed ran… | what it did |
|---|---|
| always | times with no point yet vanished while you were still working on them |
| when the number of times matched | one time with two points looked equal to one time with one point — so the second point was deleted right after you picked it. **This is the bug you reported.** |
| when the number of points matched | a pick armed the save, the save re-seeded, and the next render committed a half-typed buffer: `10:32:40` was stored as `1:00:00` |

Every one is the same mistake: the form held **two representations of the same work**, and the re-seed could only ever
destroy the one you had not saved yet.

**The re-seed is gone.** The save already writes the working copy, so it had nothing to correct. One rule now holds
everywhere in that form: *storage is the truth only when nothing is unsaved* — and a save is not such a moment, it is
the moment part of the work just became saved.

## Also fixed in this build

**Persian and Arabic digits could be lost on `Tab`.** You type ۰۸:۴۵:۵۲, the field shows 08:45:52, and pressing Tab
brought back 09:00 — because a stale flag from an earlier save let the render rebuild the form from storage and
discard the typed value. Typing now clears that flag, since typing is the clearest statement that the form is current.

**The schedule preview follows the typed time again.** It only updated during a full render, and the auto-save
deliberately does not re-render, so the preview lagged one edit behind.

**A pick now arms the auto-save.** The Pick path set its own flag and called `render()` directly instead of going
through the helper the auto-save was attached to, so a form built entirely out of picks was never saved automatically.

## Verified

```
three-times-test      11/11   milliseconds by real typing, three times each with a
                              point, auto-save with no Save press, survival across a reopen
second-pick-test       5/5    the reported bug: two points, two picks, both kept, distinct
                              targets, both in storage
pick-digits-test      21/21   Persian and Arabic numerals, typed as keystrokes
ui-basic-test         25/25   ·  pick-confirm 10/10  ·  time-survives-pick 6/6
774 unit tests, 39 files
34 browser suites green, 0 red; 2 known load flakes, both green on rerun
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