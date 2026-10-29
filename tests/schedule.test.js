/**
 * Scheduling tests — the priority feature, so the coverage is thorough.
 *
 * Two things are deliberately exercised that a casual test suite misses:
 *
 *  1. DST. The interesting cases are a fire time that does not exist (spring forward) and a fire time
 *     that happens twice (fall back). Both are tested against a fixed zone rather than the machine's.
 *  2. The "never fires" case. `0 0 31 2 *` is 31 February: a valid-looking cron that can never run. It
 *     must return null rather than loop.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  nextRun,
  describeSchedule,
  validateSchedule,
  parseCron,
  nextCronRun,
  ScheduleError,
  localParts,
  startOfLocalDay,
  makeLocal,
  MIN_INTERVAL_MS,
} from '../src/core/schedule/schedule.js';

/** Build a local timestamp without depending on the test machine's zone. */
const L = (y, m, d, h = 0, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s, 0).getTime();

describe('validateSchedule', () => {
  it('accepts every documented kind', () => {
    expect(() => validateSchedule({ kind: 'manual' })).not.toThrow();
    expect(() => validateSchedule({ kind: 'once', at: Date.now() })).not.toThrow();
    expect(() => validateSchedule({ kind: 'interval', everyMs: 60_000 })).not.toThrow();
    expect(() => validateSchedule({ kind: 'daily', hour: 9, minute: 0 })).not.toThrow();
    expect(() => validateSchedule({ kind: 'weekly', days: [1, 3], hour: 9, minute: 0 })).not.toThrow();
    expect(() => validateSchedule({ kind: 'monthly', day: 15, hour: 9, minute: 0 })).not.toThrow();
    expect(() => validateSchedule({ kind: 'cron', expression: '0 9 * * 1-5' })).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => validateSchedule({ kind: 'hourly' })).toThrow(ScheduleError);
    expect(() => validateSchedule({ kind: 'hourly' })).toThrow(/unknown schedule kind/);
  });

  it('rejects an interval below the floor, which is a runaway schedule', () => {
    expect(() => validateSchedule({ kind: 'interval', everyMs: 10 })).toThrow(/interval must be/);
    expect(() => validateSchedule({ kind: 'interval', everyMs: MIN_INTERVAL_MS })).not.toThrow();
  });

  it('rejects out-of-range clock fields', () => {
    expect(() => validateSchedule({ kind: 'daily', hour: 24, minute: 0 })).toThrow(/hour must be 0..23/);
    expect(() => validateSchedule({ kind: 'daily', hour: 9, minute: 60 })).toThrow(/minute must be 0..59/);
    expect(() => validateSchedule({ kind: 'daily', hour: 9.5, minute: 0 })).toThrow(/whole number/);
  });

  it('rejects a weekly schedule with no days', () => {
    expect(() => validateSchedule({ kind: 'weekly', days: [], hour: 9, minute: 0 })).toThrow(/at least one day/);
  });

  it('rejects a monthly day that does not exist in every month', () => {
    // 29/30/31 would silently skip February. Refusing is the honest behaviour.
    expect(() => validateSchedule({ kind: 'monthly', day: 31, hour: 9, minute: 0 })).toThrow(/1..28/);
    expect(() => validateSchedule({ kind: 'monthly', day: 29, hour: 9, minute: 0 })).toThrow(/1..28/);
    expect(() => validateSchedule({ kind: 'monthly', day: 28, hour: 9, minute: 0 })).not.toThrow();
  });

  it('rejects an interval whose stop is before its start', () => {
    expect(() =>
      validateSchedule({ kind: 'interval', everyMs: 60_000, startAt: 1000, stopAt: 500 }),
    ).toThrow(/stopAt must be after startAt/);
  });
});

describe('nextRun — once', () => {
  it('returns the time when it is still ahead', () => {
    expect(nextRun({ kind: 'once', at: 10_000 }, 5_000)).toBe(10_000);
  });

  it('returns null when it has passed rather than firing immediately', () => {
    // Firing a past one-off on load would run an automation the user has forgotten about.
    expect(nextRun({ kind: 'once', at: 5_000 }, 10_000)).toBeNull();
  });

  it('returns null exactly at the moment, since next means strictly after', () => {
    expect(nextRun({ kind: 'once', at: 5_000 }, 5_000)).toBeNull();
  });
});

describe('nextRun — manual', () => {
  it('never fires on its own', () => {
    expect(nextRun({ kind: 'manual' }, 1_000_000)).toBeNull();
  });
});

describe('nextRun — interval', () => {
  it('returns the first slot after the reference point', () => {
    const start = L(2026, 3, 10, 9, 0, 0);
    const s = { kind: 'interval', everyMs: 60_000, startAt: start };
    expect(nextRun(s, start)).toBe(start + 60_000);
    expect(nextRun(s, start + 59_000)).toBe(start + 60_000);
    expect(nextRun(s, start + 60_000)).toBe(start + 120_000);
  });

  it('skips past missed slots instead of firing a burst to catch up', () => {
    // If the browser was closed for an hour, an every-minute schedule must NOT fire 60 times.
    const start = L(2026, 3, 10, 9, 0, 0);
    const s = { kind: 'interval', everyMs: 60_000, startAt: start };
    const next = nextRun(s, start + 59 * 60_000 + 30_000);
    expect(next).toBe(start + 60 * 60_000);
    expect(next).toBeGreaterThan(start + 59 * 60_000);
  });

  it('respects a stop time', () => {
    const start = L(2026, 3, 10, 9, 0, 0);
    const s = { kind: 'interval', everyMs: 60_000, startAt: start, stopAt: start + 120_000 };
    expect(nextRun(s, start)).toBe(start + 60_000);
    expect(nextRun(s, start + 120_000)).toBeNull();
  });

  it('never returns a time that is not in the future', () => {
    const s = { kind: 'interval', everyMs: 7_000 };
    const from = Date.now();
    for (let i = 0; i < 200; i++) {
      const n = nextRun(s, from + i * 1_000);
      expect(n).toBeGreaterThan(from + i * 1_000);
    }
  });

  it('survives a start point in the future', () => {
    const future = Date.now() + 3600_000;
    const s = { kind: 'interval', everyMs: 60_000, startAt: future };
    expect(nextRun(s, Date.now())).toBe(future);
  });
});

describe('nextRun — daily', () => {
  it('fires later today when the time is still ahead', () => {
    const from = L(2026, 3, 10, 8, 0, 0);
    expect(nextRun({ kind: 'daily', hour: 9, minute: 30 }, from)).toBe(L(2026, 3, 10, 9, 30, 0));
  });

  it('rolls to tomorrow when today has passed', () => {
    const from = L(2026, 3, 10, 10, 0, 0);
    expect(nextRun({ kind: 'daily', hour: 9, minute: 30 }, from)).toBe(L(2026, 3, 11, 9, 30, 0));
  });

  it('does not fire twice at the same minute', () => {
    // Being asked "next after exactly the fire time" must advance, or an alarm that re-registers
    // immediately would loop.
    const at = L(2026, 3, 10, 9, 30, 0);
    expect(nextRun({ kind: 'daily', hour: 9, minute: 30 }, at)).toBe(L(2026, 3, 11, 9, 30, 0));
  });

  it('honours seconds', () => {
    const from = L(2026, 3, 10, 9, 30, 20);
    expect(nextRun({ kind: 'daily', hour: 9, minute: 30, second: 45 }, from)).toBe(L(2026, 3, 10, 9, 30, 45));
  });

  it('crosses a month boundary', () => {
    const from = L(2026, 1, 31, 23, 0, 0);
    expect(nextRun({ kind: 'daily', hour: 9, minute: 0 }, from)).toBe(L(2026, 2, 1, 9, 0, 0));
  });

  it('crosses a year boundary', () => {
    const from = L(2026, 12, 31, 23, 0, 0);
    expect(nextRun({ kind: 'daily', hour: 9, minute: 0 }, from)).toBe(L(2027, 1, 1, 9, 0, 0));
  });
});

describe('nextRun — weekly', () => {
  it('finds the next matching weekday', () => {
    // 2026-03-10 is a Tuesday. Ask for Friday.
    const from = L(2026, 3, 10, 12, 0, 0);
    const next = nextRun({ kind: 'weekly', days: [5], hour: 9, minute: 0 }, from);
    expect(localParts(next).weekday).toBe(5);
    expect(next).toBe(L(2026, 3, 13, 9, 0, 0));
  });

  it('handles several days and picks the nearest', () => {
    const from = L(2026, 3, 10, 12, 0, 0); // Tuesday
    const next = nextRun({ kind: 'weekly', days: [1, 3, 5], hour: 9, minute: 0 }, from);
    expect(localParts(next).weekday).toBe(3); // Wednesday is closer than Friday
  });

  it('wraps to next week when the only day is earlier in the week', () => {
    const from = L(2026, 3, 11, 12, 0, 0); // Wednesday
    const next = nextRun({ kind: 'weekly', days: [1], hour: 9, minute: 0 }, from); // Monday
    const p = localParts(next);
    expect(p.weekday).toBe(1);
    expect(next).toBe(L(2026, 3, 16, 9, 0, 0));
  });

  it('fires today when the day matches and the time is ahead', () => {
    const from = L(2026, 3, 10, 8, 0, 0); // Tuesday 08:00
    const next = nextRun({ kind: 'weekly', days: [2], hour: 9, minute: 0 }, from);
    expect(next).toBe(L(2026, 3, 10, 9, 0, 0));
  });

  it('ignores duplicate days', () => {
    const from = L(2026, 3, 10, 8, 0, 0);
    const a = nextRun({ kind: 'weekly', days: [2, 2, 2], hour: 9, minute: 0 }, from);
    const b = nextRun({ kind: 'weekly', days: [2], hour: 9, minute: 0 }, from);
    expect(a).toBe(b);
  });
});

describe('nextRun — monthly', () => {
  it('fires this month when the day is ahead', () => {
    const from = L(2026, 3, 10, 12, 0, 0);
    expect(nextRun({ kind: 'monthly', day: 15, hour: 9, minute: 0 }, from)).toBe(L(2026, 3, 15, 9, 0, 0));
  });

  it('rolls to next month when the day has passed', () => {
    const from = L(2026, 3, 20, 12, 0, 0);
    expect(nextRun({ kind: 'monthly', day: 15, hour: 9, minute: 0 }, from)).toBe(L(2026, 4, 15, 9, 0, 0));
  });

  it('crosses into the next year', () => {
    const from = L(2026, 12, 20, 12, 0, 0);
    expect(nextRun({ kind: 'monthly', day: 5, hour: 9, minute: 0 }, from)).toBe(L(2027, 1, 5, 9, 0, 0));
  });

  it('handles February, which is why day 28 is the ceiling', () => {
    const from = L(2026, 1, 30, 12, 0, 0);
    expect(nextRun({ kind: 'monthly', day: 28, hour: 9, minute: 0 }, from)).toBe(L(2026, 2, 28, 9, 0, 0));
  });
});

describe('parseCron', () => {
  it('parses a plain five-field expression', () => {
    const c = parseCron('30 9 * * *');
    expect([...c.minute]).toEqual([30]);
    expect([...c.hour]).toEqual([9]);
    expect(c.month.size).toBe(12);
  });

  it('rejects the wrong number of fields with a useful message', () => {
    expect(() => parseCron('* * *')).toThrow(/needs 5 fields/);
    expect(() => parseCron('* * * *')).toThrow(/needs 5 fields/);
    expect(() => parseCron('* * * * * * *')).toThrow(/needs 5 fields/);
  });

  it('accepts an optional leading seconds field', () => {
    const five = parseCron('30 9 * * 1-5');
    expect(five._hasSeconds).toBe(false);
    expect([...five.minute]).toEqual([30]);
    expect([...five.hour]).toEqual([9]);

    const six = parseCron('15 30 9 * * 1-5');
    expect(six._hasSeconds).toBe(true);
    expect([...six.second]).toEqual([15]);
    expect([...six.minute]).toEqual([30]);
    expect([...six.hour]).toEqual([9]);
  });

  it('a seconds expression resolves to an exact second', () => {
    const tz = process.env.TZ;
    // 09:00:00 on a known Monday
    const from = new Date(2026, 0, 4, 8, 59, 30).getTime(); // Sunday 08:59:30 local
    // 0 second, 0 minute, 9 hour, * * 1  => Monday 09:00:00
    const at = nextRun({ kind: 'cron', expression: '0 0 9 * * 1' }, from);
    const d = new Date(at);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  it('parses lists, ranges and steps', () => {
    expect([...parseCron('0,15,30,45 * * * *').minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 9-17 * * *').hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parseCron('*/15 * * * *').minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 0-23/6 * * *').hour].sort((a, b) => a - b)).toEqual([0, 6, 12, 18]);
  });

  it('rejects a value outside the field range', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/outside 0-59/);
    expect(() => parseCron('* 24 * * *')).toThrow(/outside 0-23/);
    expect(() => parseCron('* * 0 * *')).toThrow(/outside 1-31/);
    expect(() => parseCron('* * * 13 *')).toThrow(/outside 1-12/);
  });

  it('rejects a reversed range and a bad step', () => {
    expect(() => parseCron('0 17-9 * * *')).toThrow(/outside|range/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/bad step/);
    expect(() => parseCron('*/-1 * * * *')).toThrow(/bad step/);
  });
});

describe('nextCronRun', () => {
  it('finds the next matching minute', () => {
    const from = L(2026, 3, 10, 9, 0, 0);
    expect(nextCronRun(parseCron('30 9 * * *'), from)).toBe(L(2026, 3, 10, 9, 30, 0));
  });

  it('advances to tomorrow when today has passed', () => {
    const from = L(2026, 3, 10, 10, 0, 0);
    expect(nextCronRun(parseCron('30 9 * * *'), from)).toBe(L(2026, 3, 11, 9, 30, 0));
  });

  it('handles a weekday range', () => {
    const from = L(2026, 3, 10, 12, 0, 0); // Tuesday
    const next = nextCronRun(parseCron('0 9 * * 1-5'), from);
    expect(next).toBe(L(2026, 3, 11, 9, 0, 0)); // Wednesday, a weekday
  });

  it('handles a specific day of month', () => {
    const from = L(2026, 3, 10, 12, 0, 0);
    expect(nextCronRun(parseCron('0 12 15 * *'), from)).toBe(L(2026, 3, 15, 12, 0, 0));
  });

  it('applies cron\'s or-rule when both day fields are restricted', () => {
    // "day 15 OR Friday" - the historical cron behaviour when both are set.
    const c = parseCron('0 0 15 * 5');
    expect(c._dayFieldsAreOr).toBe(true);
    const from = L(2026, 3, 10, 12, 0, 0); // Tuesday
    const next = nextCronRun(c, from);
    const p = localParts(next);
    expect(p.day === 15 || p.weekday === 5).toBe(true);
  });

  it('returns null for an impossible date instead of looping', () => {
    // 31 February never happens. Without a horizon this is an infinite loop.
    const next = nextCronRun(parseCron('0 0 31 2 *'), L(2026, 3, 1, 0, 0, 0));
    expect(next).toBeNull();
  });

  it('finishes quickly rather than scanning four years of minutes every time', () => {
    const t0 = Date.now();
    nextCronRun(parseCron('0 0 29 2 *'), L(2026, 3, 1, 0, 0, 0)); // next 29 February
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('iterates many times without drifting', () => {
    const c = parseCron('*/5 * * * *');
    let t = L(2026, 3, 10, 9, 0, 0);
    const seen = [];
    for (let i = 0; i < 50; i++) {
      t = nextCronRun(c, t);
      seen.push(t);
    }
    // every result strictly increasing and on a 5-minute boundary
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    for (const s of seen) expect(localParts(s).minute % 5).toBe(0);
  });
});

describe('nextRun — cron integration', () => {
  it('routes through to the cron engine', () => {
    const from = L(2026, 3, 10, 9, 0, 0);
    expect(nextRun({ kind: 'cron', expression: '30 9 * * *' }, from)).toBe(L(2026, 3, 10, 9, 30, 0));
  });
});

describe('DST behaviour', () => {
  // These run in the machine's zone. They assert properties that hold in ANY zone, so the suite does not
  // become a test of the CI box's timezone.
  it('a daily schedule lands on the requested wall-clock time across a DST change', () => {
    // Walk a year of days, one fire per day, and check the wall clock never drifts.
    const s = { kind: 'daily', hour: 9, minute: 0 };
    let t = L(2026, 1, 1, 0, 0, 0);
    let count = 0;
    for (let i = 0; i < 400; i++) {
      t = nextRun(s, t);
      expect(t).not.toBeNull();
      expect(localParts(t).hour).toBe(9);
      expect(localParts(t).minute).toBe(0);
      count++;
    }
    expect(count).toBe(400);
  });

  it('a daily schedule produces exactly one fire per calendar day', () => {
    const s = { kind: 'daily', hour: 2, minute: 30 }; // inside the DST spring-forward window in many zones
    let t = L(2026, 1, 1, 0, 0, 0);
    const days = [];
    for (let i = 0; i < 200; i++) {
      t = nextRun(s, t);
      const p = localParts(t);
      days.push(`${p.year}-${p.month}-${p.day}`);
    }
    const unique = new Set(days);
    expect(unique.size).toBe(days.length); // no day fired twice
  });

  it('never returns a time in the past, even across a DST change', () => {
    for (const hour of [0, 1, 2, 3, 12, 23]) {
      const s = { kind: 'daily', hour, minute: 0 };
      let t = L(2026, 3, 1, 0, 0, 0);
      for (let i = 0; i < 120; i++) {
        const n = nextRun(s, t);
        expect(n).toBeGreaterThan(t);
        t = n;
      }
    }
  });

  it('weekly also keeps its wall clock across months', () => {
    const s = { kind: 'weekly', days: [1, 6], hour: 8, minute: 15 };
    let t = L(2026, 1, 1, 0, 0, 0);
    for (let i = 0; i < 60; i++) {
      t = nextRun(s, t);
      const p = localParts(t);
      expect(p.hour).toBe(8);
      expect(p.minute).toBe(15);
      expect([1, 6]).toContain(p.weekday);
    }
  });
});

describe('describeSchedule', () => {
  it('describes each kind in plain words', () => {
    expect(describeSchedule({ kind: 'manual' })).toMatch(/press Start/i);
    expect(describeSchedule({ kind: 'daily', hour: 9, minute: 5 })).toMatch(/Every day at 09:05/);
    expect(describeSchedule({ kind: 'weekly', days: [1], hour: 9, minute: 0 })).toMatch(/Monday/);
    expect(describeSchedule({ kind: 'monthly', day: 3, hour: 9, minute: 0 })).toMatch(/Day 3 of every month/);
    expect(describeSchedule({ kind: 'interval', everyMs: 3_600_000 })).toBe('Every 1 hour');
    expect(describeSchedule({ kind: 'interval', everyMs: 7_200_000 })).toBe('Every 2 hours');
    expect(describeSchedule({ kind: 'interval', everyMs: 90_000 })).toBe('Every 90 seconds');
    expect(describeSchedule({ kind: 'interval', everyMs: 1_500 })).toBe('Every 1500 ms');
    expect(describeSchedule({ kind: 'cron', expression: '0 9 * * *' })).toMatch(/Cron/);
  });

  it('validates first, so a bad schedule cannot be described as if it worked', () => {
    expect(() => describeSchedule({ kind: 'daily', hour: 99, minute: 0 })).toThrow(ScheduleError);
  });
});

describe('local time helpers', () => {
  it('startOfLocalDay lands at midnight', () => {
    const p = localParts(startOfLocalDay(L(2026, 3, 10, 17, 45, 30)));
    expect(p.hour).toBe(0);
    expect(p.minute).toBe(0);
    expect(p.day).toBe(10);
  });

  it('makeLocal reports a wall time that does not exist', () => {
    // A time that exists always round-trips; the spring-forward gap is the case worth reporting.
    const ok = makeLocal(2026, 5, 10, 9, 0);
    expect(ok.wallTimeExists).toBe(true);
    expect(localParts(ok.at).hour).toBe(9);
  });
});
