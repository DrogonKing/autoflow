/**
 * Alarms: the bridge between the pure scheduler and Chrome.
 *
 * `core/schedule/schedule.js` decides *when*; this file is the only place that talks to `chrome.alarms`.
 * Keeping the split sharp means every scheduling decision is already tested, and this file stays small
 * enough to reason about — its only job is registration and bookkeeping.
 *
 * Three real constraints of chrome.alarms that shape the code:
 *
 *  1. `periodInMinutes` is the only repeating option and its floor is 30 seconds (Chrome clamps lower
 *     values). Anything faster is not a repeating alarm; it has to be a self-rescheduling one-shot.
 *  2. Alarms do not survive a service-worker restart in a way you can trust for sub-minute schedules, so
 *     every alarm is re-derived from storage on startup.
 *  3. An alarm must be uniquely named and its name must encode the automation id, so a stale alarm from a
 *     deleted automation can be identified and cleared instead of firing forever.
 */

import {
  nextRun, validateSchedule, describeSchedule, wantsPreciseTiming, PRECISE_WAKE_MS,
} from '../core/schedule/schedule.js';
import { api } from '../platform/api.js';

export const ALARM_PREFIX = 'autoflow:run:';

/** Reschedule every enabled automation, and clear alarms that no longer belong to one. */
export async function rescheduleAll(automations, { now = Date.now() } = {}) {
  const wanted = new Set();
  const results = [];

  for (const a of automations) {
    if (!a.enabled || !a.schedule || a.schedule.kind === 'manual') continue;
    try {
      validateSchedule(a.schedule);
    } catch (e) {
      results.push({ id: a.id, name: a.name, ok: false, reason: `invalid schedule: ${e.message}` });
      continue;
    }
    const name = ALARM_PREFIX + a.id;
    const fired = await lastFiredTarget(a.id);
    /**
     * ASK FROM AFTER WHAT ALREADY FIRED.
     *
     * B2, measured: a restart / reload / import within two minutes of a target that had ALREADY RUN treated that target
     * as "just missed" and armed `now + 1000`, so the automation ran a second time - a second order, in the reported use
     * case. Both facts are now passed to `armTarget`: the evidence (`firedAt`) and the fact that the question here is
     * "what comes next". Asking from the fired target makes `nextRun` return the following occurrence directly.
     */
    /**
     * ASK FROM AFTER WHAT FIRED, BUT NOT FROM AN ANCIENT INSTANT.
     *
     * MEASURED (`reschedule-long-gap`): `fired` was used raw, so for a target that ran 30 seconds ago `nextRun(schedule,
     * fired)` returned that SAME occurrence - it had already passed - and `when = max(base, now + 1000)` armed an alarm for
     * now. A restart 30 seconds after a run therefore ran the automation a SECOND time, and a browser closed through a
     * target armed "now" instead of the next occurrence.
     *
     * `scheduleOne` already protects against exactly this with `Math.max(fired, now - 1000)`; this function did not.
     * The one-second floor keeps "ask from just before now" while making an already-passed occurrence unreachable.
     */
    const askFrom = Number.isFinite(fired) && fired < now ? Math.max(fired, now - 1000) : now;
    /**
     * `preferNext` WHEN SOMETHING ALREADY FIRED, because this caller is asking what comes NEXT.
     *
     * MEASURED (`reschedule-long-gap`): with only the one-second floor, a target that fired 30 seconds ago still came
     * back as `justMissedMs: 30000` and armed `now + 1000` - a SECOND run of a time that had already run, which is the
     * duplicate-order case the restart guard exists to prevent. `armTarget`'s "just missed" answer belongs to the other
     * question ("the user saved a time that has just gone by - should it run now?"), which is `scheduleOne`'s caller.
     *
     * A worker start, a restart and an import all come through here, and in every one of them a time that already fired
     * must wait for its next occurrence rather than firing again.
     */
    const armed = armTarget(a.schedule, askFrom, { firedAt: fired, preferNext: Number.isFinite(fired) && fired < now });
    const at = armed.at;
    if (at === null && armed.missedMs === 0) {
      results.push({ id: a.id, name: a.name, ok: false, reason: 'this schedule will not fire again' });
      continue;
    }
    wanted.add(name);
    /**
     * The target second has just gone by. arming for now is the honest reading of "I saved this time and I expect it to
     * happen" - the alternative, which was the behaviour, is a silent jump to tomorrow.
     */
    if (at === null) {
      await api.alarms.create(name, { when: now + 1000 });
      results.push({
        id: a.id, name: a.name, ok: true, at: now + 1000, target: armed.intendedAt, precise: false,
        justMissedMs: armed.missedMs, description: describeSchedule(a.schedule),
      });
      continue;
    }
    const precise = wantsPreciseTiming(a.schedule);
    /**
     * THE SAME MARGIN AS scheduleOne, from the same latency sample.
     *
     * This used to be `Math.max(at - PRECISE_WAKE_MS, now + 500)` - the fixed constant - while `scheduleOne` had
     * already been made adaptive. So every worker restart, which is the normal state between alarms, quietly put
     * every automation back on the guess that could not cover the machine's measured start latency. One rule, two
     * implementations, and they disagreed.
     *
     * No clock correction is applied. The measured offset is REPORTED only: applying it would move an order by a
     * value whose own uncertainty is half a second, which is worse than leaving it alone.
     */
    const observed = await startLatencyMs();
    const margin = Math.min(observed + PRECISE_WAKE_MS, 20_000);
    const base = precise ? Math.max(at - margin, now + 500) : at;
    const when = Math.max(base, now + 1000);

    /**
     * A TARGET THAT PASSED WHILE THE BROWSER WAS CLOSED IS NOT SILENTLY SKIPPED.
     *
     * `nextRun` returns the NEXT occurrence, so yesterday's - or this morning's - slot vanished without a trace when
     * the machine was off or the extension was not loaded. For a window that opens once a day that is the whole
     * purpose of the feature. There is no way to click a window that has closed, so the honest thing is to record
     * that it was missed and why, and to say so in the panel, rather than to arm tomorrow and look healthy.
     */
    const previous = nextRun(a.schedule, now - MISSED_LOOKBACK_MS);
    const missed = previous !== null && now - previous > 1000 && now - previous <= MISSED_LOOKBACK_MS;

    await api.alarms.create(name, { when });
    // ONE row per automation: the miss is a property of this arming, not a second schedule
    results.push({
      id: a.id, name: a.name, ok: true, at: when, target: at, precise,
      description: describeSchedule(a.schedule),
      ...(missed ? { missed: true, missedAt: previous, missedByMs: now - previous } : {}),
    });
  }

  // remove alarms whose automation is gone or now disabled
  const existing = await api.alarms.getAll();
  for (const alarm of existing) {
    if (alarm.name.startsWith(ALARM_PREFIX) && !wanted.has(alarm.name)) {
      await api.alarms.clear(alarm.name);
    }
  }

  return results;
}

/**
 * Register the alarm for one automation, replacing any previous one.
 *
 * A `cron` or `daily` schedule registers a single next occurrence rather than a repeating alarm, because
 * a repeating alarm cannot express "09:00 local, skipping DST" and would drift by an hour twice a year.
 */
/**
 * How recently an occurrence may have passed and still be treated as the one the user meant.
 *
 * THE BUG THIS FIXES, from a real export: a `daily 09:57:02` schedule was saved at 09:57:00.5. With the wake margin
 * applied the alarm was armed for 09:58:41 - 99 seconds after its own target second - so `nextRun` saw the target as
 * past and returned TOMORROW. The click never happened, and the `armed` event showed a plausible time-of-day because
 * it printed no date.
 *
 * The window is exactly zero milliseconds wide: the instant the target second passes, the next occurrence is 24 hours
 * away. MEASURED on a real machine: a worker restart 99 seconds after the target replaced a pending same-day alarm
 * with tomorrow's, and the scheduled click never happened. The user had saved the schedule correctly; the restart is
 * what lost it.
 *
 * Two minutes, chosen against the alternative rather than for roundness. Firing up to two minutes late is a bounded,
 * visible, RECORDED error - it appears in the run history and the panel says so. Skipping a whole day is unbounded and
 * invisible: the automation looks healthy and never runs. Between those, a late click is the honest failure. Two
 * minutes is also comfortably longer than the gap between an alarm firing and a run starting on a slow machine, which
 * is what created the window in the first place.
 *
 * A browser start hours after the target is unaffected: the miss is far outside the window, so the next real
 * occurrence is armed and nothing fires spuriously.
 */
const JUST_MISSED_GRACE_MS = 120_000;

/** Key for the last observed worker start latency, in storage.local so it survives a worker restart. */
const START_LATENCY_KEY = 'scheduledStartLatencyMs';

/**
 * How far back to look for an occurrence that was missed while the extension was not running.
 *
 * A day and a bit: enough to notice that this morning's window went by, short enough that a schedule left alone for
 * a month does not report thirty misses at once.
 */
const MISSED_LOOKBACK_MS = 26 * 60 * 60 * 1000;

/**
 * The latest measured gap between an alarm firing and the scheduled run actually reaching its first step.
 *
 * Kept in storage rather than memory: the whole point is to survive the worker being torn down, which is the normal
 * state of an MV3 background worker between alarms. A missing or absurd value falls back to 0, which makes the margin
 * the PRECISE_WAKE_MS floor - the old behaviour, so a fresh install is no worse than before.
 */
export async function startLatencyMs() {
  try {
    const got = await api.storage.local.get(START_LATENCY_KEY);
    const n = Number(got?.[START_LATENCY_KEY]);
    if (!Number.isFinite(n) || n < 0 || n > 60_000) return 0;
    return n;
  } catch {
    return 0;
  }
}

/** Remember how late the worker actually was, keeping the worst of the last few so one fast run cannot shrink it. */
export async function recordStartLatency(ms) {
  const n = Math.round(Number(ms));
  if (!Number.isFinite(n) || n < 0) return;
  const previous = await startLatencyMs();
  const next = Math.max(n, Math.round(previous * 0.8));
  try {
    await api.storage.local.set({ [START_LATENCY_KEY]: next });
  } catch { /* a latency hint that cannot be stored must not break the run */ }
}

/**
 * When to arm, and whether the occurrence the user meant has only just gone by.
 *
 * A thin layer over `nextRun` that refuses to jump a whole day when the target is seconds in the past. Returns the
 * instant to arm for, plus how late that occurrence already was, so the caller can record it instead of pretending the
 * schedule was on time.
 */
export function armTarget(schedule, now = Date.now(), { preferNext = false, firedAt = null } = {}) {
  const at = nextRun(schedule, now);
  const ahead = at === null ? Infinity : at - now;

  /**
   * `nextRun` ALWAYS returns a future instant, so the previous occurrence is found by asking from BEYOND the grace
   * window - not from within it. Asking from `now - grace` returns the occurrence after that point, which for a
   * daily schedule is today's target when that is still ahead and tomorrow's when it is not; asking from
   * `now - grace - 1` is what lands on the one that just passed.
   *
   * MEASURED, and this is why the arithmetic is stated: with `now` five seconds past the target, looking back 30
   * seconds and looking back 300 seconds both returned today's target, while looking back 25 hours returned
   * yesterday's.
   */
  /**
   * `preferNext` disables the "just missed" answer entirely.
   *
   * That answer exists for one question - "the user saved a time that has just gone by, should it run now?" - and it is
   * wrong for the other question this module is asked, "this run has finished, what comes next?". Answering the second
   * with the first is B1: the run's own target came back as "just missed", the caller saw `scheduled: true`, and no
   * alarm was ever created.
   */
  /**
   * AN OCCURRENCE THAT ALREADY FIRED IS NOT "JUST MISSED", whoever is asking.
   *
   * `preferNext` encodes which question the caller is asking; `firedAt` encodes what actually happened, and the second
   * is the stronger fact. Measured: with the guard gated on `preferNext` alone, a save 30 s after a target that had
   * already run still scheduled `now + 1000` and ran the automation a SECOND time - and so did `rescheduleAll` after a
   * restart. Both are the duplicate-order case in the report (B2).
   */
  const earlierForFired = nextRun(schedule, now - JUST_MISSED_GRACE_MS - 1);
  const alreadyFired = Number.isFinite(firedAt) && earlierForFired !== null && earlierForFired <= firedAt;
  const earlier = preferNext || alreadyFired ? null : earlierForFired;
  const withinGrace = earlier !== null
    && earlier <= now + 1000
    && now - earlier <= JUST_MISSED_GRACE_MS;

  /**
   * An imminent occurrence WINS over a missed one. If the next one is a few seconds away it is a better answer than
   * firing seconds late: for a 60-second interval whose tick passed 30 seconds ago, waiting 30 seconds is right and
   * firing 30 seconds late is not.
   */
  if (ahead <= JUST_MISSED_GRACE_MS) return { at, missedMs: 0 };

  if (withinGrace) {
    return { at: null, missedMs: Math.max(0, now - earlier), intendedAt: earlier };
  }

  return { at, missedMs: 0 };
}

/**
 * The occurrence each automation last actually fired, persisted.
 *
 * WHY IT HAS TO EXIST: `armTarget` decides "just missed" by looking backwards, and from the outside a target that has
 * just run and a target that has just been saved-but-not-run look identical. They are not: the first must arm the NEXT
 * occurrence, the second must run now. Without a record of what fired, a restart or an import within two minutes of a
 * target re-ran it - a second order, in the reported use case.
 */
const FIRED_KEY = 'autoflow:lastFiredTarget';

async function readLastFired() {
  try {
    const bag = await api.storage.local.get(FIRED_KEY);
    const raw = bag?.[FIRED_KEY];
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

export async function recordFiredTarget(automationId, target) {
  if (!automationId || !Number.isFinite(target)) return;
  try {
    const all = await readLastFired();
    all[automationId] = target;
    await api.storage.local.set({ [FIRED_KEY]: all });
  } catch { /* a bookkeeping failure must never stop a run */ }
}

export async function lastFiredTarget(automationId) {
  const all = await readLastFired();
  const v = all?.[automationId];
  return Number.isFinite(v) ? v : null;
}

/**
 * Arm an automation's next occurrence.
 *
 * `preferNext` is the difference between the two questions this function gets asked, and getting it wrong is B1:
 *
 *   - "the user has just saved this schedule" - a target a few seconds in the past is what they meant, so run it now.
 *   - "this run has just finished" (or failed) - that occurrence is DONE; arm the following one, always.
 *
 * With `preferNext`, an occurrence at or before the one that just fired is skipped rather than treated as missed.
 */
export async function scheduleOne(automation, { now = Date.now(), preferNext = false } = {}) {
  const name = ALARM_PREFIX + automation.id;
  await api.alarms.clear(name);
  if (!automation.enabled || !automation.schedule || automation.schedule.kind === 'manual') {
    return { scheduled: false, reason: 'manual' };
  }
  validateSchedule(automation.schedule);

  /**
   * ASK FROM AFTER THE OCCURRENCE THAT ALREADY FIRED.
   *
   * `nextRun(schedule, now)` returns the first occurrence strictly after `now`, so asking from `lastFired` returns the
   * NEXT one. This is what makes the post-run re-arm correct without a second code path: the arithmetic that produced
   * the bug is bypassed rather than compensated for.
   */
  const fired = await lastFiredTarget(automation.id);
  let askedFrom = now;
  if (preferNext && Number.isFinite(fired) && fired < now) askedFrom = Math.max(fired, now - 1000);

  const armed = armTarget(automation.schedule, askedFrom, { preferNext, firedAt: fired });
  const at = armed.at;
  /**
   * `at === null` with a `missedMs` means the occurrence the user meant has just gone by: arm for NOW so the run
   * happens, rather than returning "no future occurrence" (which is what the previous code did for 'once') or
   * deferring the whole thing by a day.
   */
  if (at === null && armed.missedMs === 0) return { scheduled: false, reason: 'no future occurrence' };
  if (at === null) {
    /**
     * CREATE THE ALARM. This branch used to return `scheduled: true` with an `at` and never touch `chrome.alarms` - and
     * since line 218 has already CLEARED the existing alarm, the automation was left with none at all while the caller
     * was told it had been scheduled. That is the whole of B1: one honest `create` call, and the return value can no
     * longer disagree with reality.
     */
    const atNow = now + 1000;
    await api.alarms.create(name, { when: atNow });
    return {
      scheduled: true,
      at: atNow,
      target: armed.intendedAt,
      precise: false,
      justMissedMs: armed.missedMs,
      reason: 'the target second had just passed; running now',
    };
  }
  // A schedule with a second is fired PRECISELY: the alarm wakes the worker early and the exact instant is
  // waited for in the page, where the timer is millisecond-resolution. Without that the click inherits the
  // alarm path's whole latency - worker wake-up, storage read, tab resolution, message round-trip.
  const precise = wantsPreciseTiming(automation.schedule);
  // The schedule's instant is used as-is. Any clock difference is reported to the user and never applied:
  // the measurement's own uncertainty is about half a second, so "correcting" by it would move an order by an
  // amount that could easily be in the wrong direction.
  /**
   * THE WAKE MARGIN IS AT LEAST THE MEASURED WORKER LATENCY, not a constant.
   *
   * The margin exists to absorb the time between the alarm firing and the precise wait actually starting: the worker
   * boots, settings are read, the tab is resolved, the message is sent. Measured on the user's machine that gap was
   * 6000ms, while the margin was a fixed 1500ms - so the alarm fired 1.5s before the target, the worker arrived 4.5s
   * late, and the precise wait clamped to "now" and fired a best-effort shot that could miss the window.
   *
   * The margin is therefore the LATEST MEASURED start latency, with the constant as a floor. A latency sample is
   * recorded on every scheduled run (see recordStartLatency), so the value adapts to the machine it runs on instead
   * of to the machine it was written on.
   */
  const observed = await startLatencyMs();
  /**
   * The margin must be STRICTLY greater than the observed latency, and the extra is not decoration.
   *
   * A margin equal to the latency means the worker wakes exactly on the target: there is no time left to wait, the
   * precise path in the page is skipped, and the click is a best-effort shot whose accuracy is the alarm's own jitter.
   * MEASURED with a margin of 6000 against a 6000ms latency: 0ms of early arrival, and the "waits for the target"
   * branch never ran. The whole point of waking early is to have something left to wait for.
   *
   * So the margin is the start latency PLUS `PRECISE_WAKE_MS`. That constant was always "how much lead the precise
   * wait needs"; keeping it as the ADDEND rather than as a floor means the precise wait always has exactly that much
   * room, on any machine, and the floor is no longer dead code dominated by a larger slack.
   */
  const margin = Math.min(observed + PRECISE_WAKE_MS, 20_000);
  const base = precise ? Math.max(at - margin, now + 500) : at;
  const when = Math.max(base, now + 1000);
  await api.alarms.create(name, { when });
  // the caller records this; kept out of here so this module stays free of the storage layer
  return { scheduled: true, at: when, target: at, precise };
}

export async function cancelOne(automationId) {
  return api.alarms.clear(ALARM_PREFIX + automationId);
}

export async function cancelAll() {
  const all = await api.alarms.getAll();
  const mine = all.filter((a) => a.name.startsWith(ALARM_PREFIX));
  await Promise.all(mine.map((a) => api.alarms.clear(a.name)));
  return mine.length;
}

/** The automation id an alarm refers to, or null if it is not ours. */
export function automationIdFromAlarm(alarmName) {
  if (!alarmName?.startsWith(ALARM_PREFIX)) return null;
  return alarmName.slice(ALARM_PREFIX.length);
}

/**
 * What is scheduled right now, for the UI to display.
 */
export async function listScheduled(automations, { now = Date.now() } = {}) {
  const alarms = await api.alarms.getAll();
  const byName = new Map(alarms.map((a) => [a.name, a]));
  return automations.map((a) => {
    const alarm = byName.get(ALARM_PREFIX + a.id);
    let next = null;
    let error = null;
    // describeSchedule VALIDATES before describing, so it throws for exactly the same schedules nextRun
    // does. Leaving it outside the try meant one broken schedule made this whole call throw, taking every
    // other automation's status down with it.
    // describeSchedule handles a manual schedule too, and its wording ("Only when you press Start") is
    // friendlier than the raw kind - so it is used for every kind, inside the try.
    let description = 'manual';
    try {
      if (a.schedule) {
        description = describeSchedule(a.schedule);
        if (a.schedule.kind !== 'manual' && a.enabled !== false) {
          next = nextRun(a.schedule, now);
        }
      }
    } catch (e) {
      error = e.message;
    }
    return {
      id: a.id,
      name: a.name,
      enabled: a.enabled !== false,
      schedule: description,
      nextAt: next ?? alarm?.scheduledTime ?? null,
      armed: Boolean(alarm),
      error,
    };
  });
}
