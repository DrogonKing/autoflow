# AutoFlow 1.39.0 — first stable release since 1.28.0

Schedules precise clicks on a trading page. Multiple independent times, each with its own picks, millisecond targets,
and a Persian/English panel. This is the first build promoted out of beta after a long series of reported faults were
found, reproduced in a real browser, and fixed.

> **The honest scope of testing.** Every fix here was measured in a controlled Chromium with the extension loaded, and
> the test that proves it is in the repository. What has **not** been proven end to end is a real trade on your live
> trading site — the selectors you recorded are positional and the site's own latency is not reproducible in a harness.
> Treat the first live run as a test: watch the Log tab.

---

## Install

**Chrome / Edge / Brave / Opera** — download `autoflow-chrome.zip`, unpack it, then
`chrome://extensions` → enable Developer mode → **Load unpacked** → pick the unpacked folder.

**A lighter build** is available as `autoflow-chrome-lite.zip` (93 KB against 140 KB). It drops the panel's extras and
keeps the scheduling core.

**Firefox** — download `autoflow-firefox.zip`. A permanent install needs Mozilla's signature, which this archive does
not carry, so use `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick `manifest.json`. Temporary
add-ons are removed when Firefox closes. A `-lite` variant exists for Firefox too.

**Source** — `autoflow-source.zip` is the full tree, including tests and security scripts.

---

## What changed since 1.28.0

Everything below was reported by the user, reproduced, and fixed with a test that fails without the fix.

### Multiple times, each with its own picks

One time per schedule is gone. Add a time, give it its own click points, add another. **Each time carries its own
targets and its own alarm** — verified end to end: three times, three points picked with a real mouse, three alarms
armed, each firing its own clicks.

A `✕` on each time removes it, and the removal is saved immediately rather than on a debounce.

### Millisecond timing

`13:50:01.250` is accepted and honoured. The field used to hold `maxlength="8"`, which silently refused the seventh
character of a twelve-character time. Fixed, and the test types with a **real keyboard** — the earlier version used
`insertText`, which bypasses `maxlength` and therefore missed the fault entirely.

### The time field behaves

Four separate faults, all measured:

- **A typed time replaces the old value.** Clicking into the field selects the current time, so entering a new one
  does not append to it. Before: `09:00:00` + nine digits became `09:00:00.103`, and `maxlength` refused the rest.
- **One save, when the value settles.** Blur, Enter, or leaving the field. Before: a save per keystroke — nine digits
  armed nineteen saves, and an idle panel made a hundred and forty-seven in five seconds.
- **Clicking anywhere else leaves the field.** The panel used to treat a press on a label or the background as "still
  in the time field" and put the caret back, so the only way out was Tab or Enter.
- **A ✓ beside each time** saves that time immediately and leaves the field — a second, visible way out.

### Focus is no longer stolen

Typing into the field was interrupted by the panel rebuilding the view. The form now remembers which field you were in,
where the caret was, and the text you had typed, and restores all three. A blur caused by the panel's own rebuild is
not treated as an edit.

### Correct page per time

A pick's page was recorded against the **first** automation regardless of which time it belonged to, so only the first
time could run — the other times failed with *"has never had an element picked in it"*. Each pick's page is now
recorded against the time that owns it.

### One firing per target, not a storm

A failed run re-armed for a moment that had already passed, and Chrome fires a past-due alarm immediately — so one
target fired three times in two seconds. Measured: three firings become one.

### A failing save no longer destroys a good alarm

An unsuccessful arming attempt cancelled an alarm that was already registered, leaving a time saved, shown as armed,
and never firing.

### Import guard

A static check that catches an identifier used but never imported — the fault class that produced two blank-panel
bugs. It had been blind five separate times; each hole was found and closed, and it is now proven in both directions:
a clean tree passes, and removing a single import fails with that name.

---

## Verified before this archive was produced

```
776 unit tests · 39 files
41 browser suites green · 0 red
import guard: clean, and proven to fail on a planted fault
```

Each release claim above has a suite that fails without its fix: `new-time-test`, `leave-field-test`,
`per-time-pick-page-test`, `remove-time-test`, `time-typing-test`, `three-times-test`, `alarm-storm-live-test`.

---

## Known limits, stated plainly

- **A live trade on your exchange has not been proven.** Timing accuracy end to end is `alarm ≈2ms → worker wake
  10–50ms → tab resolution → message 5–15ms → a 30ms wait`. A background tab is throttled by the browser and that
  cannot be worked around.
- **An alarm set less than ~30 seconds ahead fires immediately.** This is Chrome's behaviour, not a bug here.
- **Firefox needs a signature** for a permanent install.
- **Anchored selectors cannot tell two byte-identical windows apart.** If the trading site opens a second window with
  identical structure, no selector distinguishes them.
- **An automation restored from a backup arrives switched off**, deliberately.
