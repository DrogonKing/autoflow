## AutoFlow 1.40.2 — the per-time click gap, and Persian digits

Confirmed working on the real page by the user before this stable tag. Everything below was measured with a real browser and
real clicks, not inferred from the source.

## New: a click gap for each time

Beside the **time field** there is a small **⚙**. It opens one row, directly under the field it belongs to:

```
Gap between clicks   [ 20 ] ms   ✓  ✕
Milliseconds between this time's picks. 0 means they fire together. It applies to this time only.
```

Default is **0** — exactly the previous behaviour, so nothing changes until you use it. Type 20, press Enter or ✓, and that
time's picks fire 20 ms apart. **Persian and Arabic digits are accepted** (۲۰ or ٢٠), the same as the time field.

Setting a gap on one time changes nothing about any other time.

## How the gap is measured

```
gap 0   → the picks land 3–5 ms apart   (a real click costs a millisecond or two)
gap 20  → 24/24 ms apart, twice in a row, with the engine's own trace agreeing
```

The gap is a **floor between consecutive picks**, measured from the moment the previous click finished. It is never less than
the value set. A slow page therefore lengthens the real interval honestly rather than cancelling the gap — which is the fault
that made the first version look unapplied: the earlier design used one absolute target per pick, so a 24 ms click round trip
silently ate the first gap.

## Detail worth knowing

- **The first pick is never delayed.** It is the scheduled instant, which is the whole point of the schedule.
- **Only clicks consume a gap slot.** A `fill` between two picks is not a pick.
- **Clamped:** 0 to 60000 ms, digits only. A typed `-5` or `1e9` cannot become the interval.
- **One save, when the value settles** — Enter, ✓, or leaving the field. Not per keystroke.
- **The record carries it explicitly**, even at zero, so clearing the setting is a real change. Existing records have no such
  key and behave as zero — nothing to migrate.

## Fixed along the way

**Persian and Arabic digits in the gap field.** It parsed with ASCII-only digits, so ۲۰ became an empty string and the value
fell back to zero silently. The project already had a normaliser and the time field already used it; this field was written
without it.

That needed a structural fix rather than a one-line one: the normaliser lived inside `panel.js`, which runs a browser API at
file scope and cannot be imported by a unit test — so the existing test held a **copy** of the function and asserted the copy
against a copy of the expectations. It could not catch this class of fault, and did not. Digit handling is now a pure module,
imported by both the panel and the tests, so there is one definition and it is the one that runs.

**The gap settings box opened at the bottom of the form.** Pressing the gear looked like it did nothing, because the row
appeared off-screen at the end of the panel. It now renders directly under the time field.

**The diagnostic export could not show this setting.** It listed automations without their options, so a log could not settle
whether a value had been stored. The export now prints each record's `options`, and the automation line carries `gap=Nms`.

## Tooling

A browser harness can no longer measure a bundle that predates its source: `scripts/lib/fresh-build.mjs` compares the newest
source mtime against the newest bundle mtime and refuses to run, printing how far behind the build is. A stale `dist/` cost a
round of debugging **three times** in this project — twice making a fix look broken, once hiding a real bug.

## Verified

```
823 unit tests · 45 files
48 browser suites · 0 failures
click-gap-browser-test   11 ok · 0 medium · 0 HIGH
gap-persist-test         Persian digits accepted, survives closing and reopening the panel, picks land 24 ms apart
```

## Not yet proven

**A real run against the trading site.** Everything above is a controlled browser. The positional selectors and the site's
latency cannot be reproduced here, so treat the first real run as a test and read the Log tab.

Separately, and **not fixed in this build**: the log shows `FIRED TOO LATE ... by 86423068ms`. A key that resolves to the day
*before* fires as "too late" instead of on the next valid occurrence. It affects a stale date in the target, not normal use,
and is the next item.
