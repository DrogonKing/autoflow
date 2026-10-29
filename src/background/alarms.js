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
    wanted.add(name);
    const at = nextRun(a.schedule, now);
    if (at === null) {
      results.push({ id: a.id, name: a.name, ok: false, reason: 'this schedule will not fire again' });
      continue;
    }
    const precise = wantsPreciseTiming(a.schedule);
    // No clock correction is applied. The measured offset is REPORTED only: applying it would move an order by
    // a value whose own uncertainty is half a second, which is worse than leaving it alone.
    const base = precise ? Math.max(at - PRECISE_WAKE_MS, now + 500) : at;
    const when = Math.max(base, now + 1000);
    await api.alarms.create(name, { when });
    results.push({
      id: a.id, name: a.name, ok: true, at: when, target: at, precise,
      description: describeSchedule(a.schedule),
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
/** Key for the last observed worker start latency, in storage.local so it survives a worker restart. */
const START_LATENCY_KEY = 'scheduledStartLatencyMs';

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

export async function scheduleOne(automation, { now = Date.now() } = {}) {
  const name = ALARM_PREFIX + automation.id;
  await api.alarms.clear(name);
  if (!automation.enabled || !automation.schedule || automation.schedule.kind === 'manual') {
    return { scheduled: false, reason: 'manual' };
  }
  validateSchedule(automation.schedule);
  const at = nextRun(automation.schedule, now);
  if (at === null) return { scheduled: false, reason: 'no future occurrence' };
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
  const margin = Math.min(Math.max(PRECISE_WAKE_MS, observed + 1000), 20_000);
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
      nextAt: alarm?.scheduledTime ?? next,
      armed: Boolean(alarm),
      error,
    };
  });
}