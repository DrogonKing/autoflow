/**
 * THE WINDOW TAB'S MODEL: the start time (millisecond precision), the optional end, and the two separators that appear in the
 * request.
 *
 * THE REPORTED SHAPES, taken from the user's own message so the tests quote reality:
 *   "شروع 08:44:45.500 باشه"      a DOT before the milliseconds
 *   "انتهاش زمان داشته باشه 08:50:33:200"  a COLON before the milliseconds
 *
 * Both must parse. A field that rejects the shape the user actually typed reads as broken, and the difference between the two is
 * one character that carries no meaning.
 */

import { describe, it, expect } from 'vitest';
import {
  parseTimeOfDay, formatTimeOfDay, instantOnDay, resolveStartInstant, resolveEndInstant, buildWindowPlan,
  MAX_WINDOW_SPAN_MS, WINDOW_ID, buildWindowAutomation,
} from '../src/core/model/window.js';
import { validateAutomation } from '../src/core/model/steps.js';
import { wantsPreciseTiming, validateSchedule, nextRun } from '../src/core/schedule/schedule.js';

describe('parseTimeOfDay accepts every shape the user may type', () => {
  it('the documented form: a dot before the milliseconds', () => {
    expect(parseTimeOfDay('08:44:45.500')).toEqual({ hour: 8, minute: 44, second: 45, ms: 500 });
  });

  it('A COLON BEFORE THE MILLISECONDS - the shape in the request itself', () => {
    expect(parseTimeOfDay('08:50:33:200')).toEqual({ hour: 8, minute: 50, second: 33, ms: 200 });
  });

  it('no milliseconds at all is .000, not a rejection', () => {
    expect(parseTimeOfDay('08:44:45')).toEqual({ hour: 8, minute: 44, second: 45, ms: 0 });
  });

  it('a single-digit hour is widened', () => {
    expect(parseTimeOfDay('8:44:45.5')).toEqual({ hour: 8, minute: 44, second: 45, ms: 500 });
  });

  it('milliseconds are read as a FRACTION: .5 is 500 ms, not 005', () => {
    expect(parseTimeOfDay('08:44:45.5').ms).toBe(500);
    expect(parseTimeOfDay('08:44:45.05').ms).toBe(50);
    expect(parseTimeOfDay('08:44:45.005').ms).toBe(5);
  });

  it('PERSIAN digits and the PERSIAN DECIMAL separator', () => {
    expect(parseTimeOfDay('۰۸:۴۴:۴۵٫۵۰۰')).toEqual({ hour: 8, minute: 44, second: 45, ms: 500 });
  });

  it('Arabic-Indic digits too, since a keyboard may produce either', () => {
    expect(parseTimeOfDay('٠٨:٤٤:٤٥.٥٠٠')).toEqual({ hour: 8, minute: 44, second: 45, ms: 500 });
  });

  it('the THOUSANDS separator is not a decimal point', () => {
    /**
     * U+066C `٬` groups thousands and U+066B `٫` is the decimal point. Treating them as the same character once turned
     * `8٬450٬000` into a parse failure elsewhere in this project - the distinction is deliberate here.
     */
    expect(parseTimeOfDay('08٬44')).toBeNull();
    expect(parseTimeOfDay('08:44:45٬500')).toBeNull();
  });

  it('impossible values are rejected rather than clamped', () => {
    // clamping would silently run at a different time than the user asked for
    expect(parseTimeOfDay('24:00:00.000')).toBeNull();
    expect(parseTimeOfDay('08:60:00.000')).toBeNull();
    expect(parseTimeOfDay('08:44:60.000')).toBeNull();
    expect(parseTimeOfDay('08:44:45.1000')).toBeNull();
  });

  it('junk, empty and missing all return null', () => {
    expect(parseTimeOfDay('')).toBeNull();
    expect(parseTimeOfDay('   ')).toBeNull();
    expect(parseTimeOfDay('abc')).toBeNull();
    expect(parseTimeOfDay('08:44:45.500x')).toBeNull();
    expect(parseTimeOfDay(null)).toBeNull();
    expect(parseTimeOfDay(undefined)).toBeNull();
  });
});

describe('formatTimeOfDay is the round trip the field and the record share', () => {
  it('pads to HH:MM:SS.mmm, so a saved value reloads into the same field', () => {
    expect(formatTimeOfDay({ hour: 8, minute: 44, second: 45, ms: 500 })).toBe('08:44:45.500');
    expect(formatTimeOfDay({ hour: 0, minute: 0, second: 0, ms: 0 })).toBe('00:00:00.000');
  });

  it('every accepted shape formats back to the canonical one, and re-parses', () => {
    for (const input of ['08:44:45.500', '08:50:33:200', '8:44:45.5', '08:44:45']) {
      const t = parseTimeOfDay(input);
      const round = parseTimeOfDay(formatTimeOfDay(t));
      expect(round).toEqual(t);
    }
  });
});

describe('the start instant is today, or tomorrow WITH A REASON', () => {
  const at = (iso) => new Date(iso).getTime();

  it('a start later today is used as it is', () => {
    const now = at('2026-03-15T08:00:00.000Z');
    const r = resolveStartInstant('08:44:45.500', now);
    expect(r.ok).toBe(true);
    expect(r.rolledToTomorrow).toBe(false);
    expect(r.atMs).toBe(instantOnDay(now, { hour: 8, minute: 44, second: 45, ms: 500 }));
  });

  it('A START ALREADY PAST TODAY ROLLS TO TOMORROW, and says so', () => {
    /**
     * This project has already seen what happens otherwise: a schedule whose instant is in the past is refused by the engine as
     * `FIRED TOO LATE by 86 423 068 ms`. Reporting the roll keeps the user's intent and tells them what will happen, which is
     * better than either running immediately or refusing.
     */
    const now = at('2026-03-15T20:00:00.000Z');
    const r = resolveStartInstant('08:44:45.500', now);
    expect(r.ok).toBe(true);
    expect(r.rolledToTomorrow).toBe(true);
    expect(r.atMs).toBeGreaterThan(now);
    // and it is the SAME wall-clock time, a day later
    const d = new Date(r.atMs);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([8, 44, 45, 500]);
  });

  it('the roll crosses a day boundary by the calendar, not by adding 86 400 000 ms', () => {
    // a day is not a fixed number of milliseconds, and a fixed span lands on the wrong wall time across a DST change
    const now = at('2026-03-15T23:59:00.000Z');
    const r = resolveStartInstant('08:44:45.500', now);
    const d = new Date(r.atMs);
    expect(d.getDate()).not.toBe(new Date(now).getDate());
    expect([d.getHours(), d.getMinutes(), d.getMilliseconds()]).toEqual([8, 44, 500]);
  });

  it('an unusable start is an error, not a silent zero', () => {
    const r = resolveStartInstant('', at('2026-03-15T08:00:00.000Z'));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid-time');
    expect(r.atMs).toBeNull();
  });
});

describe('the end is OPTIONAL, and that is the whole point', () => {
  /**
   * "انتهاش دو حالت اگر خالی بود انقدر کلیک کنه تا گزینه استاپ رو دستی بزنم یا انتهاش زمان داشته باشه"
   * Empty means an endless window. This is the case the engine needed an explicit flag for, because an endless window and a
   * plain one-shot run are otherwise indistinguishable.
   */
  const day = new Date('2026-03-15T00:00:00.000Z').getTime();
  const start = instantOnDay(day, { hour: 8, minute: 44, second: 45, ms: 500 });

  it('EMPTY MEANS ENDLESS - a window with no deadline', () => {
    const e = resolveEndInstant('', start);
    expect(e.kind).toBe('none');
    expect(e.atMs).toBeNull();
    expect(e.error).toBeNull();
  });

  it('whitespace counts as empty', () => {
    expect(resolveEndInstant('   ', start).kind).toBe('none');
  });

  it('a time means stop at that instant, on the start day', () => {
    const e = resolveEndInstant('08:50:33:200', start);
    expect(e.kind).toBe('at');
    expect(e.error).toBeNull();
    const d = new Date(e.atMs);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([8, 50, 33, 200]);
    expect(e.atMs).toBeGreaterThan(start);
  });

  it('an END EARLIER THAN THE START is an error, not an eight-hour window', () => {
    /**
     * Only possible now because the start is pinned to its own day: 08:30 compared with a start of 08:44 is genuinely before it.
     * Treating it as tomorrow would start a run nobody asked for, so it is refused and both values are named.
     */
    const e = resolveEndInstant('08:30:00.000', start);
    expect(e.kind).toBe('at');
    expect(e.error).toBe('end-before-start');
  });

  it('an end EQUAL to the start is allowed, and describes a window that never opens', () => {
    const e = resolveEndInstant('08:44:45.500', start);
    expect(e.error).toBeNull();
    expect(e.atMs).toBe(start);
  });

  it('an end past midnight belongs to the next day, because that is the only coherent reading', () => {
    // a market that closes after 00:00 is a real case, and the numbers the user typed mean exactly this
    const lateStart = instantOnDay(day, { hour: 23, minute: 50, second: 0, ms: 0 });
    const e = resolveEndInstant('00:10:00.000', lateStart);
    expect(e.error).toBeNull();
    expect(e.atMs).toBeGreaterThan(lateStart);
    const d = new Date(e.atMs);
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 10]);
    expect(e.atMs - lateStart).toBe(20 * 60_000);
  });

  it('an unusable end is reported as such rather than becoming endless', () => {
    // silently becoming endless would be the worst outcome: the run would never stop
    const e = resolveEndInstant('99:99', start);
    expect(e.kind).toBe('none');
    expect(e.error).toBe('invalid-time');
  });

  it('THE DECISION BOUNDARY IS THE SPAN, and it is pinned in both directions', () => {
    /**
     * The two indistinguishable cases, asserted on either side of `MAX_WINDOW_SPAN_MS`. Pinned so a future change to the
     * threshold has to be deliberate: below it a crossing is believed, above it the end is called a typo.
     */
    // a start late in the day with a short crossing is BELIEVED
    const lateStart = instantOnDay(day, { hour: 23, minute: 59, second: 0, ms: 0 });
    const shortCross = resolveEndInstant('00:05:00.000', lateStart);
    expect(shortCross.error).toBeNull();
    expect(shortCross.atMs - lateStart).toBeLessThanOrEqual(MAX_WINDOW_SPAN_MS);

    // an early start with a huge implied span is CALLED A TYPO, and the span is reported
    const earlyStart = instantOnDay(day, { hour: 8, minute: 44, second: 45, ms: 500 });
    const typo = resolveEndInstant('08:30:00.000', earlyStart);
    expect(typo.error).toBe('end-before-start');
    expect(typo.atMs).toBeNull();
    expect(typo.wouldHaveCrossedMs).toBeGreaterThan(MAX_WINDOW_SPAN_MS);
  });

  it('a window just under the threshold is accepted, and just over it is not', () => {
    // the boundary itself, so "close enough" cannot drift silently
    const startMs = instantOnDay(day, { hour: 12, minute: 0, second: 0, ms: 0 });
    // an end that crosses midnight by 1 minute -> span just over 12 h -> refused
    const over = resolveEndInstant('00:01:00.000', instantOnDay(day, { hour: 12, minute: 0, second: 30, ms: 0 }));
    expect(over.wouldHaveCrossedMs ?? 0).toBeGreaterThan(MAX_WINDOW_SPAN_MS);
    // an end crossing midnight by seconds from a late start -> accepted
    const under = resolveEndInstant('00:00:10.000', instantOnDay(day, { hour: 23, minute: 59, second: 0, ms: 0 }));
    expect(under.error).toBeNull();
    expect(startMs).toBeGreaterThan(0);
  });
});

describe('buildWindowPlan produces the options the engine reads', () => {
  const now = new Date('2026-03-15T08:00:00.000Z').getTime();

  it('a start and an end give a finite window', () => {
    const p = buildWindowPlan({ startText: '08:44:45.500', endText: '08:50:33.200', nowMs: now });
    expect(p.ok).toBe(true);
    expect(p.options.window).toBe(true);
    expect(Number.isFinite(p.options.untilMs)).toBe(true);
    expect(p.options.untilMs).toBeGreaterThan(p.atMs);
  });

  it('A START WITH NO END gives an ENDLESS window - `window: true` with no deadline', () => {
    const p = buildWindowPlan({ startText: '08:44:45.500', endText: '', nowMs: now });
    expect(p.ok).toBe(true);
    expect(p.options).toEqual({ window: true });
    expect(p.options.untilMs).toBeUndefined();       // absent, so `resolveWindowEnd` sees an endless window
  });

  it('an end before the start fails the whole plan, naming the reason', () => {
    const p = buildWindowPlan({ startText: '08:44:45.500', endText: '08:30:00.000', nowMs: now });
    expect(p.ok).toBe(false);
    expect(p.error).toBe('end-before-start');
    expect(p.options).toBeNull();
  });

  it('an unusable start fails the whole plan', () => {
    const p = buildWindowPlan({ startText: 'nonsense', endText: '', nowMs: now });
    expect(p.ok).toBe(false);
    expect(p.error).toBe('invalid-time');
  });

  it('an unusable end fails the plan rather than becoming endless', () => {
    const p = buildWindowPlan({ startText: '08:44:45.500', endText: '88:00', nowMs: now });
    expect(p.ok).toBe(false);
    expect(p.error).toBe('invalid-end');
  });

  it('THE RECORD VALIDATES WITH THE PROJECT\'S OWN VALIDATOR, not with a hand-written shape check', () => {
    /**
     * The most valuable assertion here: `validateAutomation` is the same function the scheduler and the storage layer call, so a
     * record that passes it is one the rest of the extension will accept. A test that inspected fields itself would pass on a
     * record the real validator rejects.
     */
    const p = buildWindowPlan({ startText: '08:44:45.500', endText: '08:50:33.200', nowMs: now });
    const rec = buildWindowAutomation({
      plan: p,
      steps: [{ id: 'p1', kind: 'click', finder: { strategy: 'id', id: 'buy' } }],
      urls: ['https://example.test/*'],
    });
    expect(() => validateAutomation(rec)).not.toThrow();
    expect(rec.id).toBe(WINDOW_ID);
    expect(rec.schedule).toEqual({ kind: 'once', at: p.atMs });
    expect(rec.options).toEqual({ window: true, untilMs: p.end.atMs });
  });

  it('an endless record validates too, and its options carry no deadline', () => {
    const p = buildWindowPlan({ startText: '08:44:45.500', endText: '', nowMs: now });
    const rec = buildWindowAutomation({ plan: p, steps: [{ id: 'p1', kind: 'click', finder: { strategy: 'id', id: 'buy' } }] });
    expect(() => validateAutomation(rec)).not.toThrow();
    expect('untilMs' in rec.options).toBe(false);
    expect(rec.options.window).toBe(true);
  });

  it('the record is NOT armed by being built', () => {
    // opening the tab must never start a run; only an explicit save does
    const p = buildWindowPlan({ startText: '08:44:45.500', endText: '', nowMs: now });
    const rec = buildWindowAutomation({ plan: p, steps: [{ id: 'p1', kind: 'click', finder: { strategy: 'id', id: 'buy' } }] });
    expect(rec.enabled).toBe(false);
  });

  it('an unusable plan or an empty point list is refused rather than stored', () => {
    const bad = buildWindowPlan({ startText: 'nope', endText: '', nowMs: now });
    expect(() => buildWindowAutomation({ plan: bad, steps: [{ id: 'p1', kind: 'click' }] })).toThrow(/unusable plan/);
    const good = buildWindowPlan({ startText: '08:44:45.500', endText: '', nowMs: now });
    expect(() => buildWindowAutomation({ plan: good, steps: [] })).toThrow(/at least one point/);
  });

  it('THE STORED INSTANT IS FIRED PRECISELY, which is what the milliseconds were for', () => {
    /**
     * `wantsPreciseTiming` decides whether the alarm wakes early so the exact instant can be waited for IN THE PAGE, where a
     * timer has millisecond resolution. A one-shot was excluded from that, so a typed `08:44:45.500` was stored exactly and then
     * fired on the plain alarm path - whose latency is the worker wake-up, the storage read, the tab resolution and a message
     * round-trip. MEASURED by reading the record this very plan produces.
     */
    const p = buildWindowPlan({ startText: '08:44:45.500', endText: '', nowMs: now });
    const sched = { kind: 'once', at: p.atMs };
    expect(() => validateSchedule(sched)).not.toThrow();
    expect(wantsPreciseTiming(sched)).toBe(true);
    // and the instant is preserved exactly, with no rounding anywhere on the way to the schedule
    expect(sched.at).toBe(p.atMs);
    expect(new Date(sched.at).getMilliseconds()).toBe(500);
  });

  it('a one-shot whose instant has already passed is still a past one-shot, so nothing fires late', () => {
    // the precise path covers the ALARM, not the instant: an instant in the past must remain recognisably past
    const past = { kind: 'once', at: now - 5_000 };
    expect(nextRun(past, now)).toBeNull();
    expect(wantsPreciseTiming(past)).toBe(true);
  });

  it('a fractional timestamp is refused rather than rounded behind the caller\'s back', () => {
    // otherwise "is it precise" and "what instant is it" could disagree, which is the class of bug this project keeps meeting
    expect(() => validateSchedule({ kind: 'once', at: 1_000_000.5 })).toThrow();
    expect(() => validateSchedule({ kind: 'once', at: 1_000_000 })).not.toThrow();
  });

  it('the plan carries the start instant for the schedule AND the options for the runner', () => {
    /**
     * Both halves are returned together on purpose: the schedule needs an absolute instant to arm a timer for, and the runner
     * needs to know it is a window and when to stop. Deriving one from the other at the call site is how they drift apart.
     */
    const p = buildWindowPlan({ startText: '08:44:45.500', endText: '', nowMs: now });
    expect(p.atMs).toBe(p.start.atMs);
    expect(p.options.window).toBe(true);
    expect(p.start.rolledToTomorrow).toBe(false);
  });
});
