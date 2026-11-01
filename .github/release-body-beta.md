> ## ⚠️ BETA — typing a new time works, and one save per settled edit
>
> Verified in a controlled browser, **not against a real trading site yet**.

## Your report

> «عددم تغییر میدم صفر میشه بعد دوباره درست میشه همش هم پشت هم سیو میشه»
> «نمیزاره تایم جدید وارد کنم»

## What was wrong, and what is now true

**Typing a time.** With `09:00:00` in the field, clicking it and typing nine digits gave `09:00:00.103` — every
keystroke **appended** to the old value and `maxlength` then refused the rest. A new time could not be entered at all.
Clicking into the field now **selects the whole time**, so what you type replaces it:

```
09:00:00  →  "1" → "10" → "10:3" → "10:32" → … → 10:32:33.250
```

**Saves back to back.** Counting the worker's own save requests, nine digits at an unhurried pace armed **19** saves,
and an idle panel made **147 in five seconds**. Now:

```
one save when the time is settled (blur / Enter)   ·   0 saves while you are doing nothing
one save when a target is picked                   ·   one immediate save when a time or pick is removed
```

Nothing is saved while you are still typing — the save waits until you have left the field.

## Four faults found on the way

1. **A save per keystroke.** The typed-time path armed the auto-save on every input event. It now arms on commit.
2. **A render loop.** `render()` removes the focused input, the browser fires `blur` on the detached node, and the blur
   handler committed *and* rendered — one render causing the next. **147 saves in five idle seconds.** A blur caused by
   our own rebuild is no longer treated as an edit.
3. **Typed digits overwritten mid-typing.** A render from a `element-picked` message — for a pick made *before* the
   typing — rebuilt the field from the model. Typing `10:32:33.250` produced `10:02:33.300`. The half-typed text is now
   preserved across a rebuild, like the caret already was.
4. **No selection on arrival.** The field is now selected by a **real pointer press**; two other triggers were measured
   and rejected (`onfocus` also fires when the panel re-focuses after a render, wiping digits).

## One thing I removed instead of shipping it

I had added **Escape to undo a time edit**. It is not in this build. It could not be made reliable: by the time Escape
is pressed the auto-save may already have stored the typed time, so "restore the previous value" either restores what
you are abandoning or fights a save that just succeeded. A half-working undo is worse than none, so it was taken out and
the reason recorded in the code.

## Also fixed

`three-times-test` used literal targets (`10:35:00`). Run near 10:35 the third target is in the past, the alarm is
clamped to "now", and Chrome fires a sub-30-second alarm immediately — so the alarm was consumed and the record looked
unarmed. That was the intermittent "2 of 3 alarms" seen earlier. Targets are now built relative to the clock.

## Verified

```
new-time-test      8/8    typing replaces, one save, no idle saves, a second time from scratch
seven-time chunk   11/11  three times, each with its own point and its own alarm
time-typing        8/8    focus and caret survive a re-render
ui-basic          25/25   add, delete, reorder points
776 unit tests · 39 files
import check: clean, and proven to fail on a planted fault
40 browser suites green · 0 red
```

`click-icon-test` needs a window manager (bare Xvfb has none) — an environment limit, not this code.
