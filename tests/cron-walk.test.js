/**
 * B8: the cron walker and parser.
 *
 * MEASURED BEFORE THE FIX (TZ=Europe/Berlin), with the review's own repro:
 *
 *   a) every-five-minutes asked from 2026-10-25T01:30Z (02:30 local, the SECOND time round inside the fall-back)
 *      returned 02:35 local as a timestamp an hour BEFORE the question -> `.getTime() < fromMs`.
 *   b) `0 0 0 31 2 *` took 83 047 ms and returned null.
 *   c) `-5`, `every-five-steps/7`, `0x10` and `1e1` were accepted; `7` for Sunday and `MON`/`JAN` were refused.
 *
 * The tests below pin the CONTRACT rather than the implementation: "strictly after, never backwards", "an impossible
 * expression answers promptly", and a table of what the parser must and must not accept.
 */
import { describe, expect, it } from 'vitest';
import { nextCronRun, parseCron, ScheduleError } from '../src/core/schedule/schedule.js';

const next = (expr, fromMs) => nextCronRun(parseCron(expr), fromMs);
const local = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

describe('B8a: a cron candidate is always STRICTLY AFTER the question', () => {
  it('THE REPORTED CASE: asked from inside the fall-back hour, it does not go backwards', () => {
    /**
     * 2026-10-25 01:30Z is 02:30 local the second time round in Europe/Berlin. The old code rebuilt the candidate from
     * local fields, which resolve to the FIRST 02:30, and returned a time an hour in the past.
     */
    const from = Date.UTC(2026, 9, 25, 1, 30, 0);
    const r = next('*/5 * * * *', from);
    expect(r, 'no answer at all').toBeTypeOf('number');
    expect(r, `returned ${local(r)} for a question asked at ${local(from)}`).toBeGreaterThan(from);
  });

  it('and across every five-minute point of the repeated hour', () => {
    for (let min = 0; min < 120; min += 5) {
      const from = Date.UTC(2026, 9, 25, 0, 30, 0) + min * 60_000;
      const r = next('*/5 * * * *', from);
      expect(r, `from ${local(from)}`).toBeGreaterThan(from);
      expect(r - from, `gap from ${local(from)}`).toBeLessThanOrEqual(5 * 60_000);
    }
  });

  it('and around the spring-forward gap, where an hour does not exist', () => {
    for (let min = 0; min < 120; min += 7) {
      const from = Date.UTC(2026, 2, 29, 0, 15, 0) + min * 60_000;
      const r = next('*/5 * * * *', from);
      expect(r, `from ${local(from)}`).toBeGreaterThan(from);
    }
  });

  it('the ordinary case still lands on the next matching minute', () => {
    const from = Date.UTC(2026, 9, 30, 6, 2, 0);
    expect(next('*/5 * * * *', from)).toBe(Date.UTC(2026, 9, 30, 6, 5, 0));
  });
});

describe('B8b: an impossible expression answers promptly instead of hanging', () => {
  it('31 February returns null in well under a second', () => {
    const t0 = Date.now();
    const r = next('0 0 0 31 2 *', Date.now());
    const elapsed = Date.now() - t0;
    expect(r).toBeNull();
    // measured at 83 047 ms before the fix; the bound is generous so a slow CI machine is not a false failure
    expect(elapsed, `took ${elapsed}ms`).toBeLessThan(1500);
  });

  it('and the five-field form too', () => {
    const t0 = Date.now();
    expect(next('0 0 31 2 *', Date.now())).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('a legitimate once-a-year expression is still found', () => {
    // 29 February exists in 2028, so this must resolve rather than hitting a horizon
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    const r = next('0 0 0 29 2 *', from);
    expect(r).toBeTypeOf('number');
    ser(r);
  });
});

/** The 29 February case must land on a leap year. */
function ser(ms) {
  const d = new Date(ms);
  expect(d.getMonth() + 1).toBe(2);
  expect(d.getDate()).toBe(29);
  expect(d.getFullYear() % 4).toBe(0);
}

describe('B8c: the parser is strict about what it accepts', () => {
  const accepted = [
    ['0 0 * * 7', '7 is Sunday in every cron implementation'],
    ['0 0 * * MON', 'three-letter day names are standard'],
    ['0 0 1 JAN *', 'three-letter month names are standard'],
    ['*/5 * * * *', 'the ordinary step form'],
    ['0 9-17 * * MON-FRI', 'a range with a step over names'],
    ['30 4 1,15 * *', 'a value list'],
  ];
  for (const [expr, why] of accepted) {
    it(`accepts ${expr} - ${why}`, () => {
      expect(() => parseCron(expr)).not.toThrow();
    });
  }

  const refused = [
    ['-5 * * * *', 'Number() read -5 as 0-5'],
    ['*/5/7 * * * *', 'Number() read a double step as a step'],
    ['0x10 * * * *', 'Number() read hex'],
    ['1e1 * * * *', 'Number() read an exponent'],
    ['0 0 * * FUNDAY', 'not a name'],
    ['0 0 * * 8', 'out of range'],
    ['60 0 * * *', 'minute out of range'],
  ];
  for (const [expr, why] of refused) {
    it(`refuses ${expr} - ${why}`, () => {
      expect(() => parseCron(expr)).toThrow(ScheduleError);
    });
  }

  it('and 7 really means Sunday, not an out-of-range value', () => {
    const c = parseCron('0 0 * * 7');
    expect([...c.dayOfWeek]).toEqual([0]);
  });
});