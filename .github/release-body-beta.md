> ## ⚠️ BETA — a new **Window** tab: repeat your points between a start time and an optional end
>
> Measured in a controlled browser with real clicks, **not against a real trading site yet**.

## What you asked for

> «میخوام یه تب جدید داخل auto flow درست کنی... بشه بهش زمان با دقت میلی ثانیه داد اون زمان ابتدا داشته باشه ولی انتهاش
> اجباری نباشه... اگر خالی بود انقدر کلیک کنه تا گزینه استاپ رو دستی بزنم... تو این فاصله شروع کنه به ترتیب نقاط انتخاب شده
> رو بزنه و اگر نقاط تموم شد دوباره بره از اول بزنه تا زمانی که زمانش تموم بشه... مثل حالت بیسیک امکان فاصله دستی گذاشتن
> بین هر کلیک رو بزار»

A third tab beside **Basic** and **Automations**, with the fields in the order you described them:

```
Start   [ 20:44:45.500 ]  ⚙      ← mandatory, milliseconds
End     [            ]  optional  ← empty = keep clicking until you press Stop
Points  [ Pick ] …  #1  #2  #3    ← in order, clicked in that order
```

- **The start is a wall-clock instant, not a countdown.** Slowing the machine down cannot make it late.
- **An empty end means "run until I press Stop".** It repeats your points, and when they run out it starts again from the first.
- **With an end time**, it repeats the points inside the window and stops at the deadline.
- **The gap between clicks** sits behind the ⚙ beside the start time. Default **0**, e.g. `200` ms. The same rule as Basic.

## Measured, in a real browser, with real clicks

Clicks were counted **by the page itself**, not by the engine reporting on itself — a distinction that matters, because the engine can
be perfectly happy while nothing reaches the page.

```
a bounded window   476 real clicks, points repeated in order, stopped at its deadline
an endless window  kept clicking until Stop was pressed, and Stop really stopped it (311 → 311)
a scheduled window  fired by its alarm with no user action, 388 clicks in order
a real pick        pressed Pick, clicked an element on a page, the selector landed
gap 200 ms         mean interval between the same point: 408–411 ms   (two steps = two gaps = 400)
```

## Three faults found by measuring, that a green unit suite could not see

**The gap was applied everywhere except the round boundary — the boundary a window*is*.** With 200 ms set, the interval between one
arrival of the same point and the next was **211 ms** instead of ~400: the wait was applied between the steps of one pass, and the
window calls that pass again the moment the points run out. 33 unit tests were green while the feature was measurably wrong, because
every existing gap test asserted the interval *inside* one pass.

**A manual run clicked nothing.** The target tab was resolved as "whatever is in front", and pressing Run happens in the panel — so the
panel itself was in front. `the page gave no answer for the click step`. A scheduled run never hit this, which is why the same record
clicked 360 times when its alarm fired it. The tab matching the record's own URL is now preferred.

**The Stop button never rendered.** `publicActiveRun()` returns the run's **automation** id while the panel read `automationId`, a
property that was never sent — so an endless run could not be stopped from the very tab that started it.

## Why the numbers are what they are

The gap is measured from the **start** of the previous click, so the interval **is** the setting:

```
absolute off the first click:  interval = gap − cost      the gap can vanish entirely
measured from the finish:      interval = gap + cost      always widened (200 showed as 215)
measured from the start:       interval = max(gap, cost)  ← this
```

A click that takes longer than the gap still sets the interval — that is arithmetic, not a scheduling choice — but nothing pretends
otherwise now. The spread you see run to run comes from the click cost being variable, which the page decides and no scheduler can
remove.

## Reuse, so the two tabs cannot drift apart

The times are Basic's own `timeField` (digits only — `204445500` becomes `20:44:45.500`, so the colons never have to be typed), the
points are Basic's compact row (a Pick button and a selector, not the full editor's kind chooser), and the auto-save follows Basic's
rules — each of which was paid for there with a measured fault: never save while a field has focus, save what is usable rather than
refusing the whole form, never re-render from a save, and do not arm one save per keystroke.

Auditing that reuse found a **critical** fault: pressing Pick in the new tab did nothing at all. `pickControl` decided where to write by
reading a mutable global **at click time**, while the tab set it only during the build — so the pick was filed against the Basic list,
where the window's step id does not exist, and the finder was dropped without a word. A point *is* a pick, so the tab was unusable.
The slot is now an explicit parameter, with Basic's value as the default; the staging global is gone.

## Known limits, stated rather than implied

- **Absolute millisecond precision is not measured.** The window starts in the right second and the clicks are in order, but whether
  the first click lands on the `.500` itself depends on the worker's wake jitter, which is not something this code controls. The
  instant is stored exactly and handed to the alarm subsystem's precise path; the observed offset has not been quantified.
- **Never used on a real trading site.** Every measurement is against a local test page.
- The 12-hour cap on an endless window and the empty-round detector are covered by the unit suite with a virtual clock, not in a
  browser.

## Verified

```
893 unit tests · 48 files
window-tab-test    27 ok · 0 FAIL   the fields, the digits-only time, the pick-only row, the gap box
window-run-test    15 ok · 0 FAIL   476 real clicks, endless + Stop, a scheduled run, the gap measured on the page
window-pick-test    5 ok · 0 FAIL   a real page, a real pick, the page remembered for the record
all four bundles build: chrome, chrome-lite, firefox, firefox-lite
```
