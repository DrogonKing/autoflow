> ## 1.39.1 — one fix: time ids were nested, and now they are not
>
> Verified in a controlled browser, **not against a real trading site yet**.

## What was wrong

Adding times to the Basic form produced **nested, order-dependent ids**:

```
was:   basic, basic-new1, basic-new1-new1, basic-new1-new2
now:   basic, basic-new1, basic-new2, basic-new3
```

The root used to name a new time was `draft.id` — and after every save the panel sets its draft to the **first** record in
next-run order. So the root was "whichever time happens to be soonest", which changes with the clock and with every
retime. Retiming one time was measured to rename another's id.

**Why that matters more than it sounds.** These ids are what the alarms are registered under
(`autoflow:run:<id>`). An identifier that depends on sort order is the same class of fault that has already, in this
project, made a deletion remove the **wrong time** and an alarm point at the **wrong instant**. Generated ids now come
from the form itself, so they are a simple, stable counter, and an id already in use is skipped rather than taken.

Your stored data is untouched — existing ids are never rewritten. Only newly added times are named differently, and the
counter skips anything already used, so an older nested id in storage can never be duplicated.

## Verified

```
stable-ids-test  9/9   no nesting · one form root plus a counter · the ids match storage ·
                       every id unique · retiming relabels nothing · an occupied id is skipped
```

## Also investigated in this pass, and NOT bugs

Three things looked wrong in a deep sweep and were measured rather than assumed:

- **"Adding ten times only stored three records."** All ten rows were added; a time with **no point is not saved**, by
  design, because an automation with no steps fails at run time and reads as a broken clicker. The counter was right.
- **A time stored as `0:00:00.090` once.** The harness typed into a field it had not focused, so the digits went in a
  different order. Typing into the focused field — fast or slow — produces the right value every time.
- **A pick recorded for the wrong time.** The harness located the Pick button by position and pressed the wrong one.

Each of those is now asserted in the suites so they cannot be mistaken for faults again.
