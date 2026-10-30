/**
 * B1, B2, B3: the scheduling regressions from the 1.18.0 review.
 *
 * The existing suite missed all three for the same reason: no test ever gave the code a `chrome.alarms` it could
 * inspect, and the alarm paths were only ever exercised through mocks that were synchronous. A fake that RECORDS is the
 * only way to assert "an alarm exists for the next occurrence", which is the property that was broken.
 *
 * MEASURED BEFORE THE FIX (reproduced with the fake below, TZ=Europe/Berlin):
 *
 *     09:00:05 -> scheduled=true  reason="the target second had just passed; running now"  ALARM=undefined
 *     09:01:10 -> scheduled=true  reason="the target second had just passed; running now"  ALARM=undefined
 *     09:03:00 -> scheduled=true  ALARM=tomorrow 08:59:58   ok
 *
 * `scheduleOne` cleared the alarm and, in the just-missed branch, returned `scheduled: true` without creating one. Since
 * almost every run finishes within two minutes of its target, every daily automation ran once and stopped silently.
 */
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * A fake chrome whose alarms can be INSPECTED.
 *
 * Kept local to this file on purpose: a shared global fake would let one test's leftover alarms be read by another, and
 * the assertions here are about exact alarm state.
 */
function installFakeChrome() {
  const alarms = new Map();
  const store = {};
  globalThis.chrome = {
    runtime: { id: 'test', getURL: (p) => p },
    alarms: {
      create: async (name, info) => { alarms.set(name, info); },
      clear: async (name) => alarms.delete(name),
      getAll: async () => [...alarms].map(([name, i]) => ({ name, scheduledTime: i.when })),
      get: async (n) => (alarms.has(n) ? { name: n, scheduledTime: alarms.get(n).when } : undefined),
    },
    storage: {
      local: {
        get: async (k) => (k === null ? { ...store } : { [k]: store[k] }),
        set: async (o) => Object.assign(store, o),
      },
      session: { get: async () => ({}), set: async () => {} },
    },
  };
  return { alarms, store };
}

/** The module keeps no module-level alarm state, so a fresh import per test is not needed - but the fake must be new. */
async function loadAlarms() {
  return import('../src/background/alarms.js');
}

const dailyNine = (over = {}) => ({
  id: 'a1', name: 'daily', enabled: true, steps: [],
  schedule: { kind: 'daily', hour: 9, minute: 0, second: 0 },
  ...over,
});

/** A local wall-clock instant, so the test means the same thing in any TZ. */
const at = (h, m, s) => new Date(2026, 9, 30, h, m, s).getTime();
const TOMORROW_NINE = new Date(2026, 9, 31, 9, 0, 0).getTime();

describe('B1: a scheduled run always leaves a NEXT alarm', () => {
  let fake;
  beforeEach(() => { fake = installFakeChrome(); });

  it('a run finishing 5s after its target arms tomorrow', async () => {
    const { scheduleOne, ALARM_PREFIX } = await loadAlarms();
    const now = at(9, 0, 5);
    const res = await scheduleOne(dailyNine(), { now, preferNext: true });
    const when = fake.alarms.get(ALARM_PREFIX + 'a1')?.when;
    expect(res.scheduled).toBe(true);
    expect(when, 'no alarm was registered - this is B1').toBeTypeOf('number');
    expect(when).toBeGreaterThan(now);
    expect(when).toBeLessThanOrEqual(TOMORROW_NINE);
  });

  it('and 70s after, and 3min after - all three cases from the report', async () => {
    const { scheduleOne, ALARM_PREFIX } = await loadAlarms();
    for (const now of [at(9, 0, 5), at(9, 1, 10), at(9, 3, 0)]) {
      fake.alarms.clear();
      const res = await scheduleOne(dailyNine(), { now, preferNext: true });
      const when = fake.alarms.get(ALARM_PREFIX + 'a1')?.when;
      expect(res.scheduled, `at ${new Date(now).toLocaleTimeString()}`).toBe(true);
      expect(when, `no alarm at ${new Date(now).toLocaleTimeString()}`).toBeTypeOf('number');
      expect(when).toBeGreaterThan(now);
    }
  });

  it('A SAVE 30s after a target that has NEVER fired still runs now - the just-missed path is wanted there', async () => {
    const { scheduleOne, ALARM_PREFIX } = await loadAlarms();
    const now = at(9, 0, 30);
    const res = await scheduleOne(dailyNine(), { now });
    const when = fake.alarms.get(ALARM_PREFIX + 'a1')?.when;
    expect(res.scheduled).toBe(true);
    expect(when, 'the alarm must exist, and the branch must create it (this was the silent half of B1)')
      .toBe(now + 1000);
    expect(res.reason).toMatch(/just passed/i);
  });

  it('BUT a save 30s after a target that HAS fired arms tomorrow, not now', async () => {
    const { scheduleOne, ALARM_PREFIX, recordFiredTarget } = await loadAlarms();
    await recordFiredTarget('a1', at(9, 0, 0));
    const now = at(9, 0, 30);
    await scheduleOne(dailyNine(), { now });
    const when = fake.alarms.get(ALARM_PREFIX + 'a1')?.when;
    expect(when).toBeGreaterThan(at(9, 1, 0));
  });
});

describe('B2: a restart must not run an automation twice', () => {
  let fake;
  beforeEach(() => { fake = installFakeChrome(); });

  it('rescheduleAll 30s after a fired target arms tomorrow, not now', async () => {
    const { rescheduleAll, ALARM_PREFIX, recordFiredTarget } = await loadAlarms();
    await recordFiredTarget('a1', at(9, 0, 0));
    await rescheduleAll([dailyNine()], { now: at(9, 0, 30) });
    const when = fake.alarms.get(ALARM_PREFIX + 'a1')?.when;
    expect(when, 'no alarm at all').toBeTypeOf('number');
    expect(when, 'a duplicate run was scheduled - this is B2').toBeGreaterThan(at(9, 9, 0));
  });

  it('and with no record of a firing, the just-passed target still runs now', async () => {
    const { rescheduleAll, ALARM_PREFIX } = await loadAlarms();
    await rescheduleAll([dailyNine()], { now: at(9, 0, 30) });
    const when = fake.alarms.get(ALARM_PREFIX + 'a1')?.when;
    expect(when).toBe(at(9, 0, 30) + 1000);
  });

  it('several automations are independent - one firing does not suppress another', async () => {
    const { rescheduleAll, ALARM_PREFIX, recordFiredTarget } = await loadAlarms();
    await recordFiredTarget('a1', at(9, 0, 0));
    await rescheduleAll([dailyNine(), dailyNine({ id: 'a2', name: 'other' })], { now: at(9, 0, 30) });
    expect(fake.alarms.get(ALARM_PREFIX + 'a2')?.when).toBe(at(9, 0, 30) + 1000);
    expect(fake.alarms.get(ALARM_PREFIX + 'a1')?.when).toBeGreaterThan(at(9, 9, 0));
  });
});

describe('B3: the storm guard must not disable the schedule', () => {
  it('the guard re-arms instead of returning with no alarm', async () => {
    /**
     * Read the handler's source rather than driving the whole worker: the guard's decision is inline in
     * `service-worker.js`, and what matters is that the branch does not leave without arming. Asserted structurally
     * because a behavioural test needs a live worker, which the browser suite covers separately.
     */
    // a plain path: `import.meta.url` is not a file: URL under vitest's transform, so `new URL(…, import.meta.url)`
    // fails with "The URL must be of scheme file"
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('/root/autoflow/src/background/service-worker.js', 'utf8');
    const storm = src.indexOf("kind: 'storm-refused'");
    expect(storm).toBeGreaterThan(0);

    const after = src.slice(storm, storm + 1500);
    const armAt = after.indexOf('scheduleOne(');
    const returnAt = after.indexOf('return;');
    expect(armAt, 'the storm branch contains no re-arm - alarms are one-shot, so the schedule dies').toBeGreaterThan(0);
    expect(armAt, 'the branch returns BEFORE re-arming').toBeLessThan(returnAt);
  });
});

describe('the persisted firing record', () => {
  let fake;
  beforeEach(() => { fake = installFakeChrome(); });

  it('survives in storage.local, so a worker restart can read it', async () => {
    const { recordFiredTarget, lastFiredTarget } = await loadAlarms();
    await recordFiredTarget('a1', 12345);
    expect(await lastFiredTarget('a1')).toBe(12345);
    // it is in storage, not in memory
    const keys = Object.keys(fake.store);
    expect(keys.some((k) => /lastFired/i.test(k))).toBe(true);
  });

  it('is per automation', async () => {
    const { recordFiredTarget, lastFiredTarget } = await loadAlarms();
    await recordFiredTarget('a1', 1);
    await recordFiredTarget('a2', 2);
    expect(await lastFiredTarget('a1')).toBe(1);
    expect(await lastFiredTarget('a2')).toBe(2);
    expect(await lastFiredTarget('nope')).toBeNull();
  });

  it('ignores nonsense values rather than poisoning the guard', async () => {
    const { recordFiredTarget, lastFiredTarget } = await loadAlarms();
    await recordFiredTarget('a1', null);
    await recordFiredTarget('a1', NaN);
    expect(await lastFiredTarget('a1')).toBeNull();
  });
});