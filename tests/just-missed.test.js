/**
 * The zero-width arming window: a target seconds away jumped a whole day.
 *
 * FROM A REAL EXPORT. A `daily 09:57:02` schedule was saved at 09:57:00.5. With the wake margin applied, the alarm was
 * armed for 09:58:41 - 99 seconds after its own target second. `nextRun` saw the target as past and returned TOMORROW,
 * so the click never happened. The `armed` event printed `09:57:00.500`, which reads as "armed 1.5 seconds early" and
 * was in fact "armed for tomorrow". Two separate defects: the window, and a log that could not show the difference.
 */
import { describe, expect, it } from 'vitest';
import { nextRun } from '../src/core/schedule/schedule.js';

const GRACE = 120_000;

/** Mirror of armTarget in src/background/alarms.js. */
function armTarget(schedule, now) {
  const at = nextRun(schedule, now);
  const ahead = at === null ? Infinity : at - now;
  // nextRun always answers with a FUTURE instant, so the previous occurrence is found from BEYOND the window
  const earlier = nextRun(schedule, now - GRACE - 1);
  const withinGrace = earlier !== null && earlier <= now + 1000 && now - earlier <= GRACE;
  if (ahead <= GRACE) return { at, missedMs: 0 };        // an imminent one wins
  if (withinGrace) return { at: null, missedMs: Math.max(0, now - earlier), intendedAt: earlier };
  return { at, missedMs: 0 };
}

const DAY = new Date(2026, 9, 30, 9, 57, 2, 0).getTime();   // the reported target
const at = (ms) => DAY + ms;

describe('the reported case', () => {
  it('THE BUG: nextRun on its own jumps to tomorrow once the second passes', () => {
    // the alarm was armed 99 seconds after the target second, which is the situation that was created
    const now = at(99_000);
    const naive = nextRun({ kind: 'daily', hour: 9, minute: 57, second: 2 }, now);
    console.log(`  naive nextRun at +99s: ${Math.round((naive - now) / 1000)}s ahead`);
    expect(naive - now).toBeGreaterThan(80_000);          // ~a day: tomorrow
  });

  it('THE FIX: the occurrence that just passed is the one that fires', () => {
    const now = at(99_000);
    const armed = armTarget({ kind: 'daily', hour: 9, minute: 57, second: 2 }, now);
    console.log(`  armTarget at +99s: at=${armed.at} missedMs=${armed.missedMs}`);
    expect(armed.at).toBeNull();                           // not a future instant
    expect(armed.missedMs).toBe(99_000);                   // late by 99s, which the caller records
    expect(armed.intendedAt).toBe(DAY);
  });
});

describe('the grace window', () => {
  const schedule = { kind: 'daily', hour: 9, minute: 57, second: 2 };

  it('a target still ahead is armed normally', () => {
    const armed = armTarget(schedule, at(-30_000));
    expect(armed.at).toBe(DAY);
    expect(armed.missedMs).toBe(0);
  });

  it('a target 1 second ahead is still ahead, not missed', () => {
    const armed = armTarget(schedule, at(-1000));
    expect(armed.at).toBe(DAY);
  });

  it('a target 1 second past is treated as just missed, not as tomorrow', () => {
    const armed = armTarget(schedule, at(1000));
    expect(armed.at).toBeNull();
    expect(armed.missedMs).toBe(1000);
  });

  it('a target 59 seconds past is still just missed', () => {
    expect(armTarget(schedule, at(59_000)).missedMs).toBe(59_000);
  });

  it('a target 90 seconds past is still just missed, which is the case that broke', () => {
    // the measured failure was a worker restart 99 seconds after the target
    expect(armTarget(schedule, at(90_000)).missedMs).toBe(90_000);
    expect(armTarget(schedule, at(99_000)).missedMs).toBe(99_000);
  });

  it('a target well past the window is NOT treated as just missed', () => {
    /**
     * Past the grace window the honest answer is the next real occurrence. Firing an hour late would be a wrong click
     * dressed as a helpful one; the panel reports the miss instead.
     */
    const armed = armTarget(schedule, at(300_000));
    expect(armed.missedMs).toBe(0);
    expect(armed.at).toBeGreaterThan(at(300_000));         // a future occurrence
  });
});

describe('every schedule kind behaves', () => {
  it('once: a target just past runs now rather than reporting no future occurrence', () => {
    const schedule = { kind: 'once', at: at(0) };
    expect(nextRun(schedule, at(5000))).toBeNull();        // the old behaviour: gone
    const armed = armTarget(schedule, at(5000));
    expect(armed.missedMs).toBe(5000);                     // now: acted on
  });

  it('once: a target far in the past is genuinely gone', () => {
    const armed = armTarget({ kind: 'once', at: at(0) }, at(600_000));
    expect(armed.at).toBeNull();
    expect(armed.missedMs).toBe(0);
  });

  it('interval: an imminent tick WINS over one that just passed', () => {
    /**
     * For a 60-second interval whose tick passed 30 seconds ago, the next tick is 30 seconds away - and waiting is the
     * right answer. Firing 30 seconds late would be a wrong click, not a helpful one. This is the case where the
     * imminent occurrence is preferred, and it is the reason `armTarget` checks it first.
     */
    const schedule = { kind: 'interval', everyMs: 60_000, startAt: at(-60_000) };
    const armed = armTarget(schedule, at(30_000));
    expect(armed.missedMs).toBe(0);
    expect(armed.at).toBe(at(60_000));
  });

  it('cron: a just-missed minute acts', () => {
    const schedule = { kind: 'cron', expression: '0 57 9 * * *', second: 2 };
    const armed = armTarget(schedule, at(30_000));
    expect(armed.missedMs).toBeGreaterThan(0);
  });

  it('weekly does not jump a whole week for a few seconds', () => {
    const weekly = { kind: 'weekly', days: [new Date(DAY).getDay()], hour: 9, minute: 57, second: 2 };
    const armed = armTarget(weekly, at(45_000));
    expect(armed.at).toBeNull();
    expect(armed.missedMs).toBe(45_000);
  });

  it('monthly does not jump a whole month for a few seconds', () => {
    // day 30 exists in October; the model only allows 1..28, so this uses a day it accepts
    const monthly = { kind: 'monthly', day: 28, hour: 9, minute: 57, second: 2 };
    const oct28 = new Date(2026, 9, 28, 9, 57, 2, 0).getTime();
    const armed = armTarget(monthly, oct28 + 45_000);
    expect(armed.at).toBeNull();
    expect(armed.missedMs).toBe(45_000);
  });
});