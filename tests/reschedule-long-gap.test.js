import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * WHAT IS ASSERTED: the TARGET, and that it is not a second run of an occurrence that already fired.
 *
 * MEASURED while writing this: a precise schedule arms its alarm EARLIER than the target by design - the wake margin
 * absorbs worker start-up - so `when` sits up to a minute short of the target. Asserting on `when` therefore measures the
 * margin, not the schedule. `target` is the instant the user cares about, and the alarm must be inside the right
 * occurrence: for a daily schedule that is either today's time (if it is still ahead) or tomorrow's.
 */

/**
 * P1 — `rescheduleAll` arms an alarm for NOW when the last firing is long past.
 *
 * `scheduleOne` protects against this with `Math.max(fired, now - 1000)`; `rescheduleAll` did not, so a browser that was
 * closed through a target armed "now + 1s" instead of the next occurrence.
 *
 * The consequences depend on the schedule, and both are wrong:
 *   - a PRECISE schedule (second or ms set): the alarm handler later judges the run too late and skips it, but a pointless
 *     "arm now" alarm still exists and the panel shows the automation as armed;
 *   - a non-precise schedule (5-field cron, interval, daily without a second): there is no lateness check in the handler,
 *     so the automation RUNS, hours late.
 */

// the alarm name this module uses, so the fake can be asserted against
const PREFIX = 'autoflow:run:';

/**
 * A fake `chrome.alarms` plus the storage read `lastFiredTarget` needs.
 *
 * The module imports `api` from the platform layer, so the fake is installed by replacing that module. Nothing here
 * re-implements the logic under test: `rescheduleAll`, `armTarget` and `nextRun` are the real ones.
 */
const created = [];
const cleared = [];
let firedTarget = null;

vi.mock('../src/platform/api.js', () => ({
  api: {
    alarms: {
      create: (name, info) => { created.push({ name, when: info.when }); },
      clear: async (name) => { cleared.push(name); return true; },
      getAll: async () => created.map((c) => ({ name: c.name, scheduledTime: c.when })),
    },
    storage: {
      local: {
        /**
         * THE KEY MUST BE THE REAL ONE.
         *
         * MEASURED mistake in this test's first version: the mock answered under `autoflow_lastFired` while the module
         * reads `autoflow:lastFiredTarget`, so `lastFiredTarget()` always returned null and the tests passed for the wrong
         * reason - the "already fired" path was never exercised at all. The constant is copied from the module and the
         * fixture is keyed by it.
         */
        get: async (key) => {
          if (key === 'autoflow:lastFiredTarget') return { 'autoflow:lastFiredTarget': firedTarget ? { basic: firedTarget } : {} };
          return {};
        },
        set: async () => {},
      },
    },
  },
}));

const { rescheduleAll } = await import('../src/background/alarms.js');

/** A daily schedule at 09:00:00 with a second set, so a precise run and the full path are exercised. */
const preciseDaily = { kind: 'daily', hour: 9, minute: 0, second: 0, ms: 0 };
/** The same, without a second: `wantsPreciseTiming` is false and the handler has no lateness check. */
const plainDaily = { kind: 'daily', hour: 9, minute: 0 };

const at = (y, m, d, hh = 0, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss).getTime();

const run = async (schedule, { fired, now }) => {
  created.length = 0;
  cleared.length = 0;
  firedTarget = fired ?? null;
  const result = await rescheduleAll([{ id: 'basic', name: 'x', enabled: true, schedule }], { now });
  return { result, armed: created.find((c) => c.name === PREFIX + 'basic') ?? null, row: result[0] ?? null };
};

/** The target the alarm is for, read off the result row (`target` is the occurrence the run is for). */
const targetOf = (out) => out.row?.target ?? null;

/**
 * Is this instant somewhere in tomorrow's 09:00 occurrence?
 *
 * The alarm is placed EARLIER than the target on purpose (the wake margin), and `target` is the occurrence - so the check
 * is that the instant falls in a window around tomorrow 09:00 rather than exactly on it. The window is the margin's own
 * ceiling (`PRECISE_WAKE_MS` plus the measured start latency, capped at 20 s) plus room for the comparison, which is far
 * tighter than "a day earlier", the failure this test exists to catch.
 */
const isInTomorrowsNineWindow = (instant, now) => {
  if (!Number.isFinite(instant)) return false;
  const n = new Date(now);
  const tomorrowNine = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 9, 0, 0).getTime();
  return instant >= tomorrowNine - 25_000 && instant <= tomorrowNine + 2_000;
};

/** The same for TODAY's 09:00. */
const isInTodaysNineWindow = (instant, now) => {
  if (!Number.isFinite(instant)) return false;
  const n = new Date(now);
  const todayNine = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 9, 0, 0).getTime();
  return instant >= todayNine - 25_000 && instant <= todayNine + 2_000;
};

beforeEach(() => { created.length = 0; cleared.length = 0; firedTarget = null; });

describe('rescheduleAll after a long gap', () => {
  it('yesterday\'s target, now 14:00 — the alarm is for tomorrow', async () => {
    const now = at(2026, 3, 10, 14, 0, 0);
    const out = await run(preciseDaily, { fired: at(2026, 3, 9, 9, 0, 0), now });
    expect(out.armed).not.toBeNull();
    expect(isInTomorrowsNineWindow(out.armed.when, now)).toBe(true);
  });

  it('a target five days ago, now 14:00 — the alarm is for tomorrow', async () => {
    const now = at(2026, 3, 10, 14, 0, 0);
    const out = await run(preciseDaily, { fired: at(2026, 3, 5, 9, 0, 0), now });
    expect(isInTomorrowsNineWindow(out.armed.when, now)).toBe(true);
  });

  it('never fired, now 14:00 — the alarm is for tomorrow', async () => {
    const now = at(2026, 3, 10, 14, 0, 0);
    const out = await run(preciseDaily, { fired: null, now });
    expect(isInTomorrowsNineWindow(out.armed.when, now)).toBe(true);
  });

  it('yesterday\'s target, now 08:00 — the alarm is for TODAY at 09:00', async () => {
    const now = at(2026, 3, 10, 8, 0, 0);
    const out = await run(preciseDaily, { fired: at(2026, 3, 9, 9, 0, 0), now });
    const target = targetOf(out);
    const d = new Date(target);
    expect(d.getDate()).toBe(new Date(now).getDate());
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it('the target fired 30 seconds ago — the alarm is for TOMORROW, not a second run', async () => {
    const now = at(2026, 3, 10, 9, 0, 30);
    const out = await run(preciseDaily, { fired: at(2026, 3, 10, 9, 0, 0), now });
    // this is the regression: without the guard the occurrence that just ran came back as "just missed" and armed now+1s
    expect(isInTomorrowsNineWindow(out.armed.when, now)).toBe(true);
    expect(out.armed.when).toBeGreaterThan(now + 60_000);
  });
});

describe('the same rule for a schedule WITHOUT a second, where nothing else catches lateness', () => {
  it('yesterday\'s target, now 14:00 — the alarm is for tomorrow rather than running hours late', async () => {
    const now = at(2026, 3, 10, 14, 0, 0);
    const out = await run(plainDaily, { fired: at(2026, 3, 9, 9, 0, 0), now });
    expect(out.armed).not.toBeNull();
    expect(isInTomorrowsNineWindow(out.armed.when, now)).toBe(true);
  });

  it('the target fired 30 seconds ago — also tomorrow, because nothing else would catch it', async () => {
    const now = at(2026, 3, 10, 9, 0, 30);
    const out = await run(plainDaily, { fired: at(2026, 3, 10, 9, 0, 0), now });
    expect(isInTomorrowsNineWindow(out.armed.when, now)).toBe(true);
  });
});