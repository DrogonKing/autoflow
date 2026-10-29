# Fast, reliable clicking for a commodity exchange

Written for the case where a click must land at a specific moment — an IME (بورس کالا) order window
opening at a known time — with the measured numbers rather than an assurance.

**Read §4 before you rely on this.** There is one thing in this design that a browser extension cannot
do, and it matters more than any timing tweak.

---

## 1. The measured floor: ~6 ms per click

Measured through the real extension in a real Chromium, on a local page, with `stepDelayMs: 0`:

| clicks | step delay | wall time | per click | page counted |
|---|---|---|---|---|
| 20 | 0 ms | 172 ms | 8.60 ms | 20 |
| 50 | 0 ms | 328 ms | **6.56 ms** | 50 |
| 50 | 1 ms | 436 ms | 8.72 ms | 50 |
| 50 | 5 ms | 555 ms | 11.10 ms | 50 |
| 100 | 0 ms | 608 ms | **6.08 ms** | 100 |

Every step is a message round-trip: service worker → content script → DOM → back. **That round-trip is
the floor, and `delay: 0` does not remove it.** It is roughly 6 ms, and it is a property of the
architecture, not of the machine or of a setting.

Below 6 ms is not reachable in an extension. If you need it, the click has to happen inside the page in
a single tick — see §4.

**The delay is accurate where it matters.** `stepDelayMs: 5` gives 5.5 ms per click, not 50. Deadlines are
computed from elapsed time rather than accumulated sleeps, so a 500-click run does not drift.

---

## 2. Reducing the cost of each step

Every step has a fixed cost. These reduce it:

| Setting | Where | Effect |
|---|---|---|
| `Delay` per step | each step | set to `0` on the click steps; leave ~150 ms on `goto` |
| Step delay (default) | automation options | set `0` — it is `120` by default, which is 20× the floor |
| `stepRetries` | automation options | set `0` on the order steps; retries add waiting |
| `Retries` per step | each step | `0` |
| Prefer one step to two | design | a `click` on the submit button beats `focus` + `click` + `wait` |

**Do not put a `wait` step between the decision and the click.** A `wait` is a whole round-trip plus the
delay you asked for. If the page needs time, use `waitFor` on the exact element of the confirmation, so
you proceed the instant it is ready rather than after a fixed guess.

---

## 3. The one configuration that actually matters

The bottleneck for an exchange is not the 6 ms between clicks. It is **whether the click is attempted
before your own client can do it by hand**, and whether the run starts at the right instant.

**Use second-precision cron.** A five-field expression resolves only to a whole minute:

```
0 9 * * 1-5        09:00:00 on weekdays      (five fields, minute resolution)
0 0 9 * * 1-5      09:00:00 on weekdays      (six fields, SECOND resolution)
```

Both land on 09:00:00; the difference is that the six-field form lets you name the second explicitly, which
is what you need when the window opens at 09:00:00 and you want the click issued at 09:00:00 rather than
up to 59 seconds later.

**Use "Today only".** On a daily/weekly/monthly/cron schedule, `sameDayOnly` stops the schedule rolling
over to the next day when today's time has already passed:

- **off** (default): a run armed at 09:00:05 for a 09:00:00 schedule silently waits until **tomorrow**
- **on**: it reports "this schedule will not fire again today" instead

That default is correct for a daily task and wrong for a deadline. Turn it **on** for an order window.

**Arm it well ahead, and let it start the run itself.** A scheduled run goes through
`chrome.alarms`, which is the only mechanism MV3 has for firing while the service worker is asleep. Arm it
the day before and leave the browser open.

---

## 4. The limitation that matters, stated plainly

> **A browser extension cannot submit to a remote server faster than the page's own JavaScript does.**

The click you script and the click a human makes both end in the same place: the site's own request to its
own backend. The extension removes the human's reaction time — 200–400 ms of seeing, deciding and moving —
and removes the mis-click risk. It does **not** make the request faster, and it cannot beat another client
that is already inside the network path.

What that means concretely:

| Your advantage | Magnitude | Real? |
|---|---|---|
| No human reaction time before the click | 200–400 ms | **Yes, reliably** |
| The exact moment, to the second, on every attempt | yes | **Yes** |
| Clicking at 6 ms intervals instead of 300 ms | yes | **Yes**, but not the part that decides a fill |
| Beating a colocated server-side client | **no** | **No** |
| Being faster than a competing human | usually yes | Yes, over many attempts |

If the exchange or broker offers an **API** order endpoint, that is a different category of speed entirely
and worth asking them about. An extension clicking a UI is the fastest thing available *when an API is not*.

Also worth knowing: many exchanges **rate-limit, queue or reject** client-side flooding, and some treat
high-frequency client behaviour as abusive. Raising the speed past the point of usefulness can cost you the
fill. `6 ms` is the technical floor; it is not a recommendation.

---

## 5. A configuration for an order window

Steps, with the reasoning:

```
1  goto        the order page          settle time left at the default (a navigation is not instant)
2  waitFor     the order form exists    ON THE FORM, not a fixed wait. Proceeds the moment it renders.
                                        timeoutMs: 600000  (ten minutes, so a slow open does not fail)
3  fill        the quantity            value: e.g. ${quantity}  (from a CSV row if you vary it)
4  fill        the price               only if the window is not a fixed-price one
5  click       the submit button       stepDelayMs: 0
6  waitFor     the confirmation text   THIS is the proof of a fill. Do not trust step 5 alone.
```

Two things about this that are not obvious:

**Step 6 is the one that matters.** Step 5 succeeding means the click was dispatched, not that the order
was accepted. `waitFor` on the confirmation element is the only evidence the exchange agreed. Without it
you have an automation that may silently fail and leave you believing it worked.

**Step 2 backed by step 6 is what handles a late open.** If the window opens two seconds late, a fixed
`wait` of 1 second fails and a `waitFor` with a long timeout simply proceeds when the form appears.

**Rehearse with the action that cannot misfire.** Before the real attempt:

```
loop (5 times)
   waitFor    the form exists (timeoutMs: 3000)
   extract    the current price into a variable     <- reads, does not click
   wait       1000 ms
notify  "rehearsal finished"
```

You have exercised `waitFor`, `extract`, templates, the loop and the scheduler without ever pressing the
submit button. Check the run history in the panel: every step is listed with its own outcome, so a
rehearsal that "succeeded" is visible as five successful reads.

---

## 6. Failure modes to expect, and what each looks like

| Symptom | Cause | What to do |
|---|---|---|
| Run says finished, nothing happened | the click landed but the page rejected it | this is why step 6 exists — add the confirmation check |
| "could not find the element" | the page was still rendering | raise `waitFor`'s timeout; do not add a fixed `wait` |
| The order submitted twice | two submit steps, or a double-click configured | `clickCount: 1`, and one submit step only |
| "the page gave no answer" | the content script is not present (page was open before install) | reload the page; the runner injects on demand but a reload is immediate |
| The run fired a day late | the schedule rolled over past its own time | turn **Today only** on |
| Nothing fired at all | the browser was closed, or the alarm was cleared | `chrome.alarms` does not survive the browser being shut; check the Scheduled tab shows "armed" |
| The click hit the wrong button | the page changed, or the fallback chain matched loosely | re-pick the element; check the recorded chain in the step |

---

## 7. Honest summary

- **6 ms per click** is real and measured; it is the architecture's floor.
- **Reaction time removal (200–400 ms) and exact-second timing** are the genuine advantages.
- **Millisecond-level advantage over another client is not a thing in a browser extension**, and no
  setting changes that.
- **A fixed-price, quantity-limited window is decided by queue position at the server**, which an extension
  cannot influence. The extension makes sure your attempt is issued at the right moment and is not wasted;
  it does not move you up a queue.
- If the broker has an API, ask about it. That is the honest answer about speed.
