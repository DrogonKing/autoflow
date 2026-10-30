# Two faults the review found, measured and fixed

Both were reported as `[read]` - found by reading, not by running - so both were reproduced here before anything was
changed.

## B4: a queue wait was recorded as machine latency

The latency sample exists to answer one question: *how long does this machine take to get a scheduled run going?* The
answer decides how early the alarm wakes, which decides whether a click aimed at a second lands on it.

```
one 80 ms sample          -> startLatencyMs = 80 ms     (margin 1580 ms)
then one 6000 ms sample   -> startLatencyMs = 6000 ms   (margin 7500 ms)
five fast runs after that -> 1966 ms                    (margin 3466 ms)
```

The 6000 ms was not the machine. It was a run **waiting in the queue** behind another automation, and the sample was
`startedAt - firedAt`, which cannot tell the two apart. Worse, the update is `max(new, 0.8 * old)`, so the inflated value
decays by only 20% per run - it stayed wrong for the rest of the session.

An inflated margin means the alarm wakes the worker seconds before the target. That is the failure mode the margin
exists to prevent.

**The fix** measures the queue separately: `queuedMs` is recorded when the slot is finally claimed, subtracted from the
sample, and logged as `start-queued-wait` when it is above 250 ms so the number is visible rather than assumed.

## B7: a restore could erase everything

```
-- before the restore --
2 automations: خرید فزر, خرید شستا

-- restore a corrupt / partial file --
importAll -> imported=0  skipped=3
-- after --
0 automations
```

`importAll(doc, { replace: true })` started from an empty list, so a file whose every item was refused - corrupt, from
another version, or carrying a script step that is held back - saved the empty list. The user's own backup button wiped
every automation they had, and the result read as a successful import of nothing.

A second case, measured with one usable item and two broken ones:

```
2 automations -> 1
```

So even a *successful* restore deleted work the file never mentioned.

**Three changes, each with its own reason:**

1. **A replace that imported nothing touches nothing**, and reports `refused: true` with the reason. Nothing was
   imported, so there is nothing to replace.
2. **`replace` no longer means "delete what the file omits"**. It means what a person means by it: for an id in both the
   file and here, the file wins. Removing an automation is the Delete button, not a side effect of restoring a backup.
3. **Imported automations arrive switched off**, and nothing is armed for them. A file is data from outside this
   machine; nothing in it should be able to schedule an order before a person has read it. Turning one on is one click,
   and the click is the review.

## Verification

`tests/latency-and-import.test.js` - 8 tests:

```
B4  the sample excludes the time spent waiting for the slot
    a queued run records what it waited, so the subtraction is visible
    the arithmetic really does remove it  (6080 ms -> 80 ms)
B7  a file where EVERY item is refused leaves everything untouched
    a partial file ADDS to what is here instead of replacing it
    an imported automation arrives SWITCHED OFF, whatever the file says
    a file that CANNOT be parsed at all changes nothing
    replace still lets the FILE win for an id that appears in both
```

`scripts/backup-restore-test.mjs` was asserting the old contract ("AND THEY ARE RE-ARMED") and now asserts the pair that
matters: **nothing is armed on import**, and **enabling one does arm it** - so "off until you turn it on" cannot be a dead
end where nothing ever runs. 10/10, twice.