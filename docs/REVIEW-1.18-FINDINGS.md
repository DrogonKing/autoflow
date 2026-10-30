# The 1.18.0 review: what was real, and what fixing it broke

An external review of 1.18.0 listed over twenty findings, tagged `[run]` (reproduced) or `[read]` (found by reading). No
claim was accepted without reproducing it here first. This is the record of what happened, including the three
regressions my own fixes introduced.

## P0 — the scheduling regressions

### B1. After a scheduled run, the next alarm was never created

Reproduced with a fake `chrome.alarms` that records, in `TZ=Europe/Berlin`:

```
now=09:00:05  scheduled=true  reason="the target second had just passed; running now"  ALARM=undefined
now=09:01:10  scheduled=true  reason="the target second had just passed; running now"  ALARM=undefined
now=09:03:00  scheduled=true  ALARM=tomorrow 08:59:58   ok
```

`scheduleOne` cleared the alarm at line 218 and, in the just-missed branch, returned `{ scheduled: true, at: now + 1000 }`
**without calling `alarms.create`**. Only `rescheduleAll` created an alarm in that case. Since almost every run finishes
within two minutes of its target, every `daily` and `weekly` automation ran once and stopped silently - and nothing
reported an error, because the return value said it had been scheduled.

The fix has two halves, and both are needed:

- `scheduleOne` takes `preferNext`, because the function is asked two different questions: *"the user just saved this
  schedule, a target a few seconds in the past is what they meant"* and *"this run has finished, arm the following
  one"*. Collapsing them is the bug.
- The branch now actually creates the alarm it claims to have scheduled, so the return value cannot disagree with
  `chrome.alarms` again.

**Acceptance** (`tests/alarm-rearm.test.js`, 11 tests): all three times from the report end with a registered future
alarm; a save 30 s after a target that has not fired registers `now + 1 s`; a save 30 s after one that has fired registers
tomorrow's.

### B2. A restart ran the automation a second time

The same fault from the other side: `rescheduleAll` within two minutes of a target that had **already run** treated it
as missed and armed `now + 1000` - a second order, in the reported use case. `lastFiredTarget` is now persisted per
automation, and the guard is applied on **evidence** rather than on which caller is asking:

```js
const alreadyFired = Number.isFinite(firedAt) && earlierForFired !== null && earlierForFired <= firedAt;
```

The first version gated the guard on `preferNext` alone; measured, a save 30 s after a fired target still ran it again.
The caller's intent is not evidence.

### B3. The storm guard killed the schedule

`return` in the storm branch, and `chrome.alarms` entries are one-shot - so refusing a firing left the automation with no
alarm at all until the next browser start. The guard now records the event **and** re-arms from one millisecond after the
refused target. Its job is to stop a storm, not to disable a schedule.

### B6. `activeRun` could wedge forever

There was no `try/finally` anywhere in the file. A throw from `storage.session.set`, `setBadge` or `makeHost` after the
slot was claimed left the lock held and every later run refused until the worker restarted, with no error to explain it.
Everything after the claim is now inside `try/finally`, and `releaseSlot` is idempotent so the normal path releasing it
early is harmless.

## P1 — wrong results and real-world damage

### B5. The URL pattern matcher could click the wrong site

Measured, with the old `pattern.split('*').map(escape).join('.*')`, for `*://*.example.com/*`:

| URL | old | correct |
|---|---|---|
| `https://www.example.com/page` | match | match |
| `https://example.com/` | **no match** | match |
| `https://evil.com/x.example.com/y` | **match** | no match |
| `https://notexample.com/` | no match | no match |

The dangerous row is the third: the host part of a URL may not contain a slash, so a URL whose **path** contained the
domain matched on a completely unrelated host - meaning clicks and form fills could be delivered to a site the user never
named. Replaced with a real match-pattern parser (`src/core/net/match-pattern.js`), 14/14 against the review's table.

Also removed: the fallback to the active tab when no pattern matched. That is what made a mismatched automation click on
whatever the user was looking at.

**Two faults in my own matcher, found by running the suite:**

- A full URL used as its own pattern did not match itself, because the host charset rejected `:`, so `127.0.0.1:8080`
  parsed as `null`.
- `file://` URLs have an **empty host** (`file:///path` has no authority), which the parser rejected outright. A pattern
  naming a local file therefore matched nothing, and the worker opened a second copy of the page and clicked there -
  measured as five runs reporting `finished steps=1` with correct pointer coordinates while the page being watched logged
  zero clicks.

### B8. Cron

Reproduced in `TZ=Europe/Berlin`:

| case | before | after |
|---|---|---|
| `*/5` asked from inside the fall-back hour | returned a time an hour **before** the question | strictly after |
| `0 0 0 31 2 *` | **83 047 ms**, then `null` | 2 ms, `null` |
| `-5`, `*/5/7`, `0x10`, `1e1` | accepted | refused |
| `7` for Sunday, `MON`, `JAN` | refused | accepted |

Three separate causes. The walk rebuilt each candidate from **local** fields, which resolves a repeated hour to its
first occurrence, so it moved backwards; it is now entirely absolute milliseconds. It stepped one second at a time, so an
impossible date cost four years of iterations; it now skips whole units that cannot match. And `Number()` accepted
anything numeric-looking.

**A fourth fault, caught by my own new test:** `0 0 0 29 2 *` returned `null` even though 29 February 2028 is inside the
horizon. Skipping a day by adding 86 400 000 ms lands on **UTC** midnight - 01:00 local - so the `00:00` instant that the
expression waits for was never visited. A day boundary is a local concept.

### B9. Templates

```
${missing|default:fallback}  -> THROWS "unknown variable"   (the README advertises default)
${x|default:a|b}             -> THROWS "unknown modifier b"
${row.constructor}           -> "function Object() { [native code] }"
${now+1d.date} at 2026-03-28 23:30 -> 2026-03-30   (a day too far)
${now+1d.date} at 2026-10-25 00:30 -> 2026-10-25   (the same day)
```

The head was evaluated before the pipes could apply, so the default could never rescue it. Prototype lookup used `in`,
which walks the chain. And `+1d` added a fixed 24 h, which is wrong across a DST boundary: a day is a **calendar** unit,
so it is `setDate`.

### B10. The stop reason blamed the user

```
stop step          -> "stopped-by-user"   (the user did nothing)
break outside loop -> "stopped-by-user"   (a bug in the automation)
```

Every `RunAborted` was collapsed into one reason. There are now three: `stopped-by-step`, `stray-break`, `stopped-by-user`.

**And the first version of this fix was wrong:** the host's stop check threw `RunAborted('stopped by user')`, whose
message was indistinguishable from a step's reason text, so pressing Stop reported `stopped-by-step`. The check now
throws a sentinel.

### B11. Three messenger faults

- `element-pick-cancelled` was in the content-script allowlist with **no case** in the worker, so the panel never heard
  that a pick was cancelled and its button stayed in "picking" forever.
- `waitFor` was in `ELEMENT_KINDS`, so validation demanded a finder for every wait - "wait until the URL contains X"
  could not be saved.
- An `extract` passed `__resolve` as a **function**, and functions do not cross the extension message port. `${var}` in
  an extract finder was silently ignored. It now resolves with the same `resolveStep` every other step uses.

### Found while fixing: two bugs that predate the review

**`listScheduled` was never imported.** `list-scheduled` answered `{ ok: false, error: "listScheduled is not defined" }`
while the alarm itself was correctly registered - so the panel could not show which automations were armed. Measured, and
it made `e2e-test` and `firefox-test` fail on a check that could never have passed.

**72 duplicate i18n definitions.** The second entry silently wins in a JS object literal, so `finder.positionalTitle`
made the **English** table serve **Persian** text. `scripts/dedupe-i18n.py` removes them and exits non-zero, so a build
step can treat a duplicate as a finding rather than a note.

## The three regressions the fixes caused

Worth recording, because the pattern is the same every time: **a rule that is right in one path is wrong in another, and
only executing the whole suite shows it.**

1. **`trigger is not defined`** - the manual-tab fallback was restored *inside the alarm handler*, where `trigger` does
   not exist. That handler is a scheduled run by definition; the manual path needs no fallback because
   `startAutomationLocked` already resolves `tabId ?? the active tab`.
2. **A port in a pattern** - the host charset rejected `:`, so a specific URL could not be used as its own pattern.
3. **`file://` has no host** - see above; this one was invisible in the unit suite and only appeared as "the page logs
   zero clicks".

## Verification

```
658 unit tests
alarm-rearm.test.js   11   B1/B2/B3, with a recording chrome.alarms
cron-walk.test.js     21   B8, including the two DST transitions
stop-reasons.test.js  10   B10/B11
time-field.test.js    28   the masked time field
```

Every browser suite, 28 of them, green on chromium and firefox: multi-schedule 5/5, schedule-live 8/8, slow-worker 9/9,
missed-slot 6/6, run-guard-race 7/7, e2e 28/28, browser 20/20, firefox 31/31, security 10/10, sim 19/19, sim-file 8/8,
sim-windows 23/23, anchor 9/9, drag 9/9, skew-and-pick 13/13, log-export 22/22, i18n 16/16, build-guard 7/7,
pick-confirm 10/10, pick-digits 21/21, ui-basic 25/25, save-button 12/12, backup-restore 8/8, export-content 10/10.

## Not fixed

- **B4 (start-latency sample includes queue wait)**, B7 (import replace can erase), and the P2 list were not reached.
  They are recorded rather than silently dropped.
- The real trading site has still not been tested: no live selector for the buy button exists yet.