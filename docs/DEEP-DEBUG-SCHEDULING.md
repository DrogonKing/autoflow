# Deep debug: the scheduling path

After the schedule still did not fire on the reporting machine, the whole path was re-examined against a simulated
slow worker (measured 6000ms between the alarm firing and the run starting). Four defects were found. Three of them
were introduced by my own earlier fixes.

## 1. A missing import made every alarm fail, and the re-arm turned that into a storm

`startLatencyMs` was used in the handler but never imported. The import patch had matched a *different* line - the same
helper list appears in `alarms.js`'s own import - and silently changed nothing.

The symptom was severe: **nine alarms fired one second apart and not a single click happened.**

```
23:10:35  armed + alarm-fired
23:10:36  alarm-fired → step-error → re-arm
23:10:37  alarm-fired → step-error → re-arm
...
```

Each firing looked reasonable in isolation, so nothing reported a problem. Found by capturing the worker's own run
records (`step-error startLatencyMs is not defined`) rather than by reading the code.

## 2. The re-arm re-armed the occurrence that had just failed

Independent of the import bug, and the reason the storm repeated rather than ending:

`scheduleOne(x)` means "the next occurrence from **now**". When the failure happens *before* the target, that is the
same occurrence, seconds away - so the failing start re-armed the instant it had just failed. The retry storm consumed
the very second it was aiming at.

The re-arm now asks from **one millisecond after the failed target**, refuses to arm if the result is not in the
future, and records `re-armed` or `arm-skipped` so the decision is visible in the export.

## 3. A hard storm guard

Even with correct arithmetic, this class of bug is quiet and expensive, so more than **three firings inside ten
seconds** for one automation is refused outright and recorded as `storm-refused`. The shortest schedule the model
allows is a whole second and would not be armed this way, so the guard can never reject legitimate behaviour.

## 4. The adaptive margin skipped the precise path

Making the wake margin adaptive introduced a second failure that the first fix hid:

- the margin became `latency + 2500` (later `latency + PRECISE_WAKE_MS`), and
- the handler's window stayed `PRECISE_WAKE_MS + 5000`, a fixed 6.5s.

So an alarm armed 20s early woke the worker with the target 20s away, outside the window. The code concluded it was
early for a *future* occurrence, set `atMs = null` and fired immediately - **the precise wait was skipped exactly when
it was needed most.**

Also measured: a margin *equal* to the latency leaves 0ms to wait, so the precise path never runs either. The margin
must be strictly greater, which is why `PRECISE_WAKE_MS` is now the addend rather than a floor that was dominated by a
larger slack and could never bind.

Both numbers now come from the same formula and the same sample. `tests/wake-margin.test.js` pins their agreement for
every latency from 0 to 17500ms.

## 5. `rescheduleAll` ignored the adaptive margin

It runs at every worker start, so it is the path that actually matters after the browser has been asleep - and it kept
`Math.max(at - PRECISE_WAKE_MS, now + 500)`, the old constant. Every restart quietly downgraded every automation back
to the guess. One rule, two implementations, and they disagreed.

## 6. A missed occurrence vanished without a trace

If the browser was closed at the target, `nextRun` returned **tomorrow** and today's slot disappeared silently. That is
the whole purpose of a once-a-day window. `rescheduleAll` now looks back up to 26 hours and reports `missed`,
`missedAt` and `missedByMs` - there is no way to click a window that has closed, so the honest thing is to say so.

## Measured after all of it

```
planted worker latency : 6000ms
armed                  : 7500ms before the target  (6000 to travel + 1500 to wait)
click landed           : 23:12:15:00  - exactly on the target second
firings                : 1  (not 9)
export                 : armed, alarm-fired, run-finished
missed detection       : missedByMs 86400190 for a slot a day earlier
```

`scripts/slow-worker-test.mjs` 9/9, `scripts/schedule-live-test.mjs` 8/8, and 554 unit tests, including
`tests/wake-margin.test.js` (9) and `tests/alarm-storm.test.js` (9).
