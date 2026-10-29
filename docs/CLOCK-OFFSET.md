# Clock offset, and why "fire 2 seconds early" was wrong advice

## The advice, and why it was wrong

I told the user to set the schedule 2-3 seconds early "for safety". That was wrong, and the user caught it:
milliseconds matter, so why give up 2 seconds?

The measured behaviour:

```
set 09:00:00  ->  click lands at 09:00:00.005    (+5ms, LATE)
set 08:59:58  ->  click lands at 08:59:58.005    (2s EARLY - the window is not open yet)
```

Padding early only helps a system that fires LATE. This one fires 4-8ms late, which is safe for an order
window. Padding made it strictly worse. The advice is withdrawn.

## What can actually move the click by seconds

Exactly one thing: **the machine's clock being wrong.** The extension's own latency is single-digit
milliseconds (measured, five runs: +4, +5, +5, +6, +8ms). A clock that is 2 seconds off moves the click by 2
seconds, in either direction, and nothing inside the extension can detect that from the schedule alone.

So the offset is **measured** rather than guessed at.

## How it is measured

One same-origin `HEAD` request to the site the automation targets, and only the `Date` response header is read:

```
t0 ──────── send ───────▶ server          stamp = Date header
t1 ◀────── receive ────── server

offset = serverStamp - (t0 + rtt / 2)
```

Three samples, median taken. A positive offset means the **server is ahead**, i.e. this machine is behind.

### The honest limitation

An HTTP `Date` header has **one-second resolution** - the format has no sub-second part. So the measurement
cannot be better than about ±500ms plus half the round-trip jitter. That is why the warning threshold defaults
to **1000ms** and not 200ms: a warning that fires on noise teaches the user to ignore it.

## A warning, and a separate switch

The user asked for the offset to be **reported, not applied** - and for an option to apply it. So:

| Behaviour | Default | Where |
|---|---|---|
| Measure and show the offset | on | the schedule editor, next to the time |
| Warn when it is at least a threshold apart | 1000ms | Settings |
| **Apply** the correction to the schedule | **off** | Settings, explicit switch |

With the switch off, nothing moves. With it on, the schedule's instant is treated as **server time** and the
alarm is set at `target - offset` on this machine's clock. Both instants are reported separately
(`target` and `targetLocal`) so the correction is observable rather than invisible.

That distinction cost a bug: the first version reported only `target`, so the correction could not be seen from
outside and appeared to do nothing.

## The cost: this is the extension's only network request

Before this, the extension made **zero** network requests, and that was a documented, tested claim. It no
longer is. The trade is deliberate and the security tests were rewritten to say something narrower and
stronger rather than weaker:

```
exactly ONE fetch call site, in src/background/service-worker.js
method: 'HEAD'            -> no body can carry page content out
credentials: 'omit'       -> no cookies
headers.get('date')       -> only the Date header is read
!/^https?:/i.test(url)    -> a data: or blob: URL is refused
not on the content-script allowlist -> a web page cannot trigger it
no XMLHttpRequest, WebSocket, EventSource or sendBeacon anywhere
```

That is a stronger position than "no network at all", because it says what the one call can and cannot do.

## What still cannot be fixed

- **A sleeping machine.** If the laptop suspends, the alarm may not fire at all. No page timer can fix that.
- **A browser that is closed.** Same.
- **A background tab.** Chromium throttles timers there to about one per second. `focusBeforePrecise` (default
  on) brings the tab forward before a second-precise click, which lifts the throttle - but it takes focus.
- **The order being accepted.** "Clicked" is not "accepted". A `wait for` step after the click is what proves
  it, and nothing here replaces that.