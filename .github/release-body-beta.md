> ## ⚠️ BETA — a click gap for each time
>
> Measured in a controlled browser with real clicks, **not against a real trading site yet**.

## What you asked for

> «یه علامت تنظیمات کوچیک برای هر زمان انتخابی… گزینه فاصله کلیک بین pickها داخل یه زمان مشخص… دیفالتش صفره… مثلا برای
> 10:10:50.250 با سه تا pick… بشه بین پرتاب اون سه تا pick اختلاف ۲۰ میلیثانیهای گذاشت. فقط برای اون زمان مشخص»

Beside the **time field** there is now a small **⚙**. It opens one row:

```
Gap between clicks   [ 20 ] ms   ✓  ✕
Milliseconds between this time's picks. 0 means they fire together. It applies to this time only.
```

Default is **0** — exactly the behaviour you had. Type 20, press Enter or ✓, and that time's picks fire 20 ms apart. No other
time is touched.

It sits on the **field** rather than on the chip because you said "for each *selected* time", and the field is where the
selected time is. It is also always visible, whereas the chip row is hidden when there is only one time.

## Measured, in a real browser

```
gap 0   → the three picks land  3–4 ms apart    (a real click costs a millisecond or two)
gap 20  → the three picks land  18/20 ms apart, and 21/19 on another run
a second time with no gap → still 3–4 ms apart  ← the setting did not leak
```

## Why the gap is computed the right way

The obvious implementation — sleep the gap after each click — measures from the **end** of one click to the **start** of the
next, so every click's own duration is added. At 20 ms with clicks that take a couple of milliseconds you drift, and on a
slow page the drift accumulates, so the last of three picks lands well past 10:10:50.290.

Each pick's target here is **absolute**: the instant the first pick landed, plus its index times the gap. A slow click cannot
push the following ones back — it just has less waiting left to do, and if it overran the next target the next click starts
immediately rather than pretending to wait. `tests/click-gap.test.js` asserts the instants, not the sleeps, including a
click that takes longer than the gap.

## Detail worth knowing

- **The first pick is never delayed.** It is the scheduled instant, which is the whole point of the schedule.
- **Only clicks consume a gap slot.** A `fill` between two picks is not a pick, and spacing it would change what the step does.
- **Clamped:** 0 to 60000 ms, digits only. A typed `-5` or `1e9` cannot become the interval.
- **One save, when the value settles** — Enter, ✓, or leaving the field. Not per keystroke, for the same reason the time
  field is not: a save per keystroke made the panel unusable.
- **The record carries it explicitly**, even at zero, so clearing the setting is a real change. A record saved before this
  build has no such key and behaves as zero — nothing to migrate.

## Two faults found while building it, both fixed

**The gap was dropped on every reload.** The panel rebuilds its rows from the stored records field by field, so a field not
named there is silently lost — a gap of 20 ms came back as 0 after reopening the panel. Found by the test, not by reading.

**The chip row is hidden with a single time** — correct in itself (a chooser with one choice is noise, and two tests assert
it), but it meant a gear placed on the chip was unreachable in the common case. That is why the gear is on the field.

## Verified

```
811 unit tests · 44 files (up from 801)
click-gap-browser-test   11 ok · 0 medium · 0 HIGH
click-gap.test.js        10 tests — the instants, the clamp, per-time isolation, a slow click, a click slower than the gap
events-ui 9/9 · remove-time 15/15
```