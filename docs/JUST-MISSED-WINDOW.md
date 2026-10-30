# The zero-width arming window

## What the export showed

```
armed  {"automationId":"basic","precise":true,"target":1793428022000,"via":"save"}  09:57:00.500
alarm  autoflow:run:basic  at 09:57:00.500
automation  basic  schedule=daily 09:57:02
export taken 09:59:23
```

Read as text, that says: armed at 09:57:00.500 for a 09:57:02 target, 1.5 seconds early, which is correct. It was in
fact armed **for tomorrow**, and the time-of-day still looked right because the `armed` line printed only a clock time.

## What actually happened

The arming was fine. A **worker restart** then ran at about 09:58:41 - 99 seconds after the target second - and:

```
nextRun({daily 09:57:02}, 09:58:41)  ->  09:57:02 TOMORROW
```

`rescheduleAll` runs at every worker start and clears the old alarm before creating the new one. So the correct,
pending, same-day alarm was **replaced with tomorrow's**, and the click never happened. The schedule was never wrong;
the restart lost it.

## The window is zero milliseconds wide

Measured directly against the real function:

```
3 s before the target  -> today
2 s before the target  -> today
exactly at the target  -> TOMORROW
1 s after the target   -> TOMORROW
```

The instant the target second passes, the next occurrence is a day away. `sameDayOnly` exists for exactly this case,
but no UI sets it and it was the wrong place to put the decision.

## The fix, and why two minutes

`armTarget()` now refuses to jump a day when the target has just gone by, and returns `missedMs` so the caller records
that it was late. The grace window is **two minutes**, chosen against the alternative rather than for roundness:

- firing up to two minutes late is a **bounded, visible, recorded** error - it shows in the run history and the panel
  says so;
- skipping a whole day is **unbounded and invisible** - the automation looks healthy and never runs.

Between those, the late click is the honest failure. Two minutes is also comfortably longer than the gap between an
alarm firing and a run starting on a slow machine, which is what created the window.

A browser opened hours after the target is unaffected: the miss is far outside the window, so the next real occurrence
is armed and nothing fires spuriously. A `once` schedule whose time passed ten seconds ago now runs instead of being
reported as dead.

An imminent occurrence still wins over a missed one: for a 60-second interval whose tick went by 30 seconds ago,
waiting 30 seconds for the next tick is right and firing 30 seconds late is not.

## Two log defects found on the way

1. `stamp()` printed no date. An arming for tomorrow and an arming for today were indistinguishable. It now appends
   `(2 Nov)` when the instant is not on the reference day, and nothing when it is.
2. `decisionTrail()` - the section of the export a person reads first - filtered against a list that did **not**
   include `armed`, `fired-late` or `fired-too-late`. Those events were being recorded and then dropped. A writer and a
   reader with different lists is the same failure as two code paths disagreeing.

## Measured after

```
armed     06:38:12.500  missed  for 06:38:14.000  (precise)  via save
click     06:38:14:00   - exactly the target second
firings   1
```

`scripts/missed-slot-test.mjs` 6/6 twice, `slow-worker-test.mjs` 9/9, `schedule-live-test.mjs` 8/8, 571 unit tests.
