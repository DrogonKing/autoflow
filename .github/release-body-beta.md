> ## ⚠️ BETA — three fixes you reported
>
> All three reports in your log are addressed. Verified in a controlled browser with **real keystrokes**, not against a
> real trading site yet. Please test with a target you do not mind missing.
>
> **Your log was from 1.21.0**, so two of the three needed reproducing on the current build first — one of them did not
> exist in the form you saw it in, and the other was worse than reported.

## Your three reports

**۱. «کمتر از ثانیه نمیذاره انتخاب کنم و نمیتونم میلی ثانیه اضافه کنم»**

Real, and present in the current build too. The field had `maxlength="8"`, which is exactly `HH:MM:SS` — while
`HH:MM:SS.mmm` needs **twelve** characters. The browser refused the seventh character, so the fraction was unreachable
by typing.

My own millisecond test passed because it used `keyboard.insertText()`, which sets the value through the `input` event
and is not subject to `maxlength`. That is the same blind spot as `element.click()` skipping hit-testing, which this
project has been bitten by before. The new test types one keystroke at a time.

```
before: maxlength="8"   typing 9 digits → "09:00:00.135"
after:  maxlength="12"  typing 9 digits → "13:50:01.500"
```

**۲. «فقط زمان اولی رو شلیک کرد و pickهای زمان دوم و سوم شلیک نشدن»**

Reproduced as a real fault, and worse than the report: after a save the panel held **two different pictures of your
work** — three rows in the working copy and one record in the draft. Any later render could rebuild the rows from the
draft, produce a single row, and drop the points you had picked into the others.

Now the rows are re-seeded from storage after a save — but only when **every** time was actually stored. The first
version of that fix re-seeded unconditionally and was worse: with three times where only the first had a point, the
other two vanished from the form while you were still working on them.

**۳. Auto-save**

Added, as asked. A change to the form saves itself **1.2 seconds after you stop editing** — add, delete, reorder,
retype, pick.

- It is the **same save the button runs**, not a lighter second path that could disagree about which points were stored.
- It **never rebuilds the view**. Two attempts at re-rendering both detached the element the pointer was moving toward —
  "Element is not attached to the DOM" — which is the fault you reported in 1.24.0. An automatic save has nothing to
  draw: the form already shows what you typed.
- A time with no point yet is **not** an error, so merely typing a time does not raise "at least one point is needed".
- The Save button still works, and still shows you the armed time.

## Verified

```
11/11  three-times: milliseconds by real typing, three times each with a point,
       auto-save with no Save press, survival across a reopen, independent targets
774    unit tests, 39 files
31+    browser suites green, 0 red; 3 known load flakes, all green on rerun
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