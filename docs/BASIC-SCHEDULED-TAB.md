# A Basic automation has no URL, and a scheduled run must still find its page

The user's export, 1.19.0:

```
-- runs --------------------------------------------------------
-  basic  step-error  steps=0  0ms
   ERROR: this automation has no URL pattern, so a scheduled run has no safe tab - add one, or run it by hand

-- scheduled alarms -------------------------------------------
(no alarms registered)
```

It did not run. The message is honest, and it is my regression.

## What happened

The Basic tab's draft is built with `urls: []` - the form never asks for a URL, so **every** automation built there has no
pattern. In 1.19.0 the active-tab fallback was removed from the alarm path, correctly: measured, it delivered clicks and
form fills to whatever page the user happened to have in front (`REVIEW-1.18-FINDINGS.md`, B5). But removing it left the
Basic case with **no answer at all**. An automation that had been running for weeks started refusing to run, and the
refusal sounded like a configuration mistake the user was expected to fix.

## Why a fallback to the page the pick came from is not the same fallback

The old fallback was a **guess**: at firing time, "whatever is in front". The record is not a guess - it is the page the
user was looking at when they picked the element this automation clicks. There is exactly one moment when that pairing is
known for certain, and it is the moment of the pick.

So it is recorded then, and consulted **last**:

1. the automation's URL patterns, matched by the real match-pattern parser;
2. a concrete URL from those patterns, opened deliberately;
3. **the page its pick came from** - reopened if it is not open;
4. only then, a refusal that says what to do.

## Two faults in my first attempt

**It lived in the panel.** The record was written from the panel's `element-picked` handler, so it only existed while the
panel was open - and the case that matters is a scheduled run with the panel closed. Measured: `lastPickPages: null` after
a real pick. The worker receives the pick from the content script either way, so the worker owns the record.

**Nothing knew which automation the pick was for.** `element-picked` arrives from a content script that has no idea. The
panel's per-step Pick button is the only thing that knows, so it now sends `automationId` with `pick-element`, and the
worker carries it in `pendingPick`.

A page still cannot redirect an automation: `remember-pick-page` is deliberately **not** in `CONTENT_SCRIPT_MESSAGES`.

## Verification

`scripts/basic-scheduled-test.mjs` reproduces the report's exact sequence - pick for a named automation, save with
`urls: []`, arm for a second a few seconds away, then **wait without pressing Run now**. 9/9, twice:

```
the alarm is armed for the target
the scheduled run did NOT fail for lack of a tab      (no error)
the run finished rather than erroring                 finished
and the page shows the click                          0 -> 1
on the target the automation names                    ["نقطه ۲"]
pad2 counted it once                                  1
```

`tests/basic-page-memory.test.js` (5 tests) pins the ordering as well as the behaviour: the remembered page must be
consulted **before** the refusal, so it can never end up as dead code behind an early return. That is the mistake that
made the previous version of this look correct while doing nothing.

## What this does not fix

An automation that has **never** had an element picked in it still cannot run on a schedule - there is genuinely no page
to choose, and the message now says so ("never had an element picked in it... pick one of its steps once, or add a URL")
instead of talking about a URL pattern the user never had a field for.