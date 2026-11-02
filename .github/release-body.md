> ## 1.39.2 — three faults from the review, each reproduced before being fixed
>
> Verified in a controlled browser and by executing the real functions, **not against a real trading site yet**.

Three of the review's findings were confirmed by reproducing them here, then fixed. Each has a test that fails
without the fix — checked by reverting the fix and watching the suite go red.

## P0 — `sendToTab`'s retry threw `ReferenceError` [was real]

```
ReferenceError: safeMessage is not defined
```

`safeMessage` was declared with `const` **inside** the `try` and used by the retry in the `catch`. Out of scope there, so
content.js was injected and the message was **never re-sent**.

Why it mattered more than a confusing error: the first attempt after an extension reload, or on a freshly opened tab, is
exactly the case this retry exists for. With a scheduled precise run the first element step has already consumed `atMs`,
so the runner's retry has no target time left and the click can fire **before** its instant.

`tests/send-to-tab-retry.test.js` — 5 tests. The function is extracted from the source and run against a stubbed browser
API, with the **real** `cloneableOrString`, so the test cannot pass on a stub that does nothing.

## P1 — `rescheduleAll` armed *now* after a long gap, and re-ran a recent one [was real]

`scheduleOne` had `Math.max(fired, now - 1000)`; `rescheduleAll` used `fired` raw. Two separate consequences, both
measured:

- a target that fired **30 seconds ago** came back as `justMissedMs: 30000` and armed `now + 1000` — a **second run** of
  a time that had already run. This is the duplicate-order case the restart guard exists to prevent;
- a target from yesterday or five days ago armed "now", so a schedule without a second **ran hours late**.

Both halves are fixed: the one-second floor, and `preferNext` when something already fired. `tests/reschedule-long-gap.test.js`
— 7 tests over the review's five rows plus the no-second variants. Reverting either half fails 3 of them.

## P3 — `parseNum` treated every comma as a thousands separator [was real]

```
"12,50"   → 1250     (a hundredfold error on a price)
"12٫50"   → NaN      (the Persian decimal separator was not handled)
```

A condition comparing 12.5 against 1250 is silently the wrong question. The comma is now a thousands separator **only
when it groups exactly three digits**; otherwise it is the decimal point. All three real-world shapes are handled —
`1,234.56` (Anglo), `1.234,56` (European) and a bare `12,50` — plus U+066B, and Persian/Arabic digits.
`tests/decimal-comma.test.js` — 7 tests.

## Not done in this build, and why

- **P2, the late-alarm policy** — the review itself says this needs a product decision. A per-automation
  `lateToleranceMs`, applied to *every* schedule kind, plus a visible signal when a run is skipped, is a feature rather
  than a defect fix. It is not in this build, and the current behaviour is unchanged and documented below.
- **P3's smaller items** (stop after `newTab`/`switchTab`, stopping a `repeat` with zero gap, `focusBeforePrecise`
  visibility, the clock-offset sample correlation). They are real and are next.

## Current behaviour worth knowing

- **An alarm set less than ~30 seconds ahead fires immediately** — Chrome's behaviour, not this code.
- **`clickAll` inside a run ends the run** by design and by test. The review's note about the loop not yielding to
  `abort-step` was **not reproduced**: `stepAborted` is checked by the existing `clickAll` suite, so that item is
  unconfirmed rather than fixed.
- **A precise run brings the target tab into focus by default.** It will take the window from whatever you are doing.