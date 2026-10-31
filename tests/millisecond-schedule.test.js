/**
 * Milliseconds in the schedule: the user's actual case.
 *
 * The request was "13:50:01.500" - a target INSIDE a second, because a market opens at a fixed instant and the click has
 * to be sent early enough to arrive after the ping and the site's own latency.
 *
 * These tests use the REAL modules: `parseTypedTime` and `timeFieldValue` from the panel are what the field actually
 * calls, and `nextRun` from the scheduler is what the worker arms. A test that reimplemented the parser would prove
 * nothing about the shipped path - and this parser has been wrong before in exactly that way (a reimplementation in a
 * test asserted the old behaviour and locked a bug in).
 *
 * A minimal `chrome` stub is installed BEFORE the imports, because panel.js registers a message listener at module scope
 * and reaching for `chrome.runtime` at import time is what every one of its unit tests would otherwise trip over. The
 * stub records nothing and does nothing; the panel's message plumbing is exercised by the browser suites instead.
 */
import { describe, expect, it } from 'vitest';

/**
 * panel.js calls boot() at module scope, which renders into `#root`. jsdom has no such element, so the import leaves an
 * unhandled rejection behind: the assertions still pass, but vitest reports "1 error", and noise like that is how a real
 * error gets ignored later. Supplying the element the panel expects keeps the import clean.
 */
document.body.innerHTML = '<div id="root"></div>';

globalThis.chrome ??= {
  runtime: {
    onMessage: { addListener() {} },
    sendMessage: async () => undefined,
    getURL: (p) => `chrome-extension://test/${p}`,
    lastError: undefined,
  },
  storage: {
    local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    session: { get: async () => ({}), set: async () => undefined },
  },
  tabs: { query: async () => [], sendMessage: async () => undefined },
  alarms: { create() {}, clear: async () => true, getAll: async () => [] },
};

const { parseTypedTime, timeFieldValue, formatTimeDigits, timeDigits } = await import('../src/ui/panel/panel.js');
const { nextRun, validateSchedule, wantsPreciseTiming, makeLocal } = await import('../src/core/schedule/schedule.js');

describe('the field accepts a millisecond fraction', () => {
  it("parses the user's example: 13:50:01.500", () => {
    const r = parseTypedTime('135001500');
    expect(r.ok).toBe(true);
    expect(r.hour).toBe(13);
    expect(r.minute).toBe(50);
    expect(r.second).toBe(1);
    expect(r.ms).toBe(500);
  });

  it('parses it as typed with colons and a dot', () => {
    const r = parseTypedTime('13:50:01.500');
    expect(r).toMatchObject({ ok: true, hour: 13, minute: 50, second: 1, ms: 500 });
  });

  it('pads a short fraction on the RIGHT, because it is a decimal', () => {
    // .5 is half a second, not five milliseconds
    expect(parseTypedTime('1350015').ms).toBe(500);
    expect(parseTypedTime('13500105').ms).toBe(50);
    expect(parseTypedTime('135001005').ms).toBe(5);
  });

  it('accepts nine digits and no more', () => {
    expect(parseTypedTime('135001500').ok).toBe(true);
    // A tenth digit is not an error: the MASK caps at nine, so it is dropped before the parser sees it. Asserting on the
    // parser alone would have described a code path the field never takes.
    expect(timeDigits('1350015001')).toBe('135001500');
    expect(parseTypedTime(timeDigits('1350015001'))).toMatchObject({ ok: true, ms: 500 });
  });

  it('is unchanged for a plain time: no fraction still means zero', () => {
    const r = parseTypedTime('135001');
    expect(r).toMatchObject({ ok: true, second: 1, ms: 0 });
    expect(r.precise).toBe(true); // a second was given
  });

  it('still rejects an impossible hour/minute/second', () => {
    expect(parseTypedTime('250001')).toMatchObject({ ok: false, error: 'hourRange' });
    expect(parseTypedTime('136001')).toMatchObject({ ok: false, error: 'minuteRange' });
    expect(parseTypedTime('135099')).toMatchObject({ ok: false, error: 'secondRange' });
  });

  it('a fraction is precise', () => {
    expect(parseTypedTime('135001500').precise).toBe(true);
  });
});

describe('the field shows the fraction back', () => {
  it("round-trips the user's example", () => {
    const r = parseTypedTime('135001500');
    const shown = timeFieldValue({ hour: r.hour, minute: r.minute, second: r.second, ms: r.ms });
    expect(shown).toBe('13:50:01.500');
  });

  it('hides a zero fraction, so the ordinary case stays short', () => {
    expect(timeFieldValue({ hour: 9, minute: 0, second: 0, ms: 0 })).toBe('09:00:00');
    expect(timeFieldValue({ hour: 9, minute: 0, second: 0 })).toBe('09:00:00');
  });

  it('keeps leading zeros in the fraction: 50 ms is .050, not .50', () => {
    expect(timeFieldValue({ hour: 13, minute: 50, second: 1, ms: 50 })).toBe('13:50:01.050');
  });

  it('the mask draws a decimal rather than a fourth colon group', () => {
    expect(formatTimeDigits('135001500')).toBe('13:50:01.500');
    expect(formatTimeDigits('135001')).toBe('13:50:01');
    expect(timeDigits('13:50:01.500')).toBe('135001500');
  });
});

describe('the schedule carries the fraction into the armed instant', () => {
  it('nextRun lands ON the millisecond, not on the whole second', () => {
    const from = new Date(2026, 9, 31, 13, 49, 0, 0).getTime(); // one minute before
    const at = nextRun({ kind: 'daily', hour: 13, minute: 50, second: 1, ms: 500 }, from);
    const d = new Date(at);
    expect(d.getSeconds()).toBe(1);
    expect(d.getMilliseconds()).toBe(500);
  });

  it('without ms the target is the whole second, exactly as before', () => {
    const from = new Date(2026, 9, 31, 13, 49, 0, 0).getTime();
    const at = nextRun({ kind: 'daily', hour: 13, minute: 50, second: 1 }, from);
    expect(new Date(at).getMilliseconds()).toBe(0);
  });

  it('makeLocal keeps the milliseconds it is given', () => {
    const { at } = makeLocal(2026, 9, 31, 13, 50, 1, 500);
    expect(new Date(at).getMilliseconds()).toBe(500);
  });

  it('weekly and monthly respect the fraction too', () => {
    const from = new Date(2026, 9, 31, 0, 0, 0, 0).getTime(); // Sat 31 Oct 2026
    const weekly = nextRun({ kind: 'weekly', days: [6], hour: 13, minute: 50, second: 1, ms: 250 }, from);
    expect(new Date(weekly).getMilliseconds()).toBe(250);
    // day 31 is refused by validation — the model only permits 1..28, because every month has those
    const monthly = nextRun({ kind: 'monthly', day: 1, hour: 13, minute: 50, second: 1, ms: 750 }, from);
    expect(new Date(monthly).getMilliseconds()).toBe(750);
  });

  it('a LEAD is expressible: firing before a whole second', () => {
    // the market opens at 08:45:00; the click must go out BEFORE it
    const from = new Date(2026, 9, 31, 8, 44, 59, 0).getTime();
    const at = nextRun({ kind: 'daily', hour: 8, minute: 44, second: 59, ms: 950 }, from);
    const d = new Date(at);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(950);
    const open = new Date(2026, 9, 31, 8, 45, 0, 0).getTime();
    expect(at).toBeLessThan(open);
  });
});

describe('validation and precise mode', () => {
  it('accepts ms 0..999 and rejects outside that', () => {
    expect(() => validateSchedule({ kind: 'daily', hour: 9, minute: 0, ms: 0 })).not.toThrow();
    expect(() => validateSchedule({ kind: 'daily', hour: 9, minute: 0, ms: 999 })).not.toThrow();
    expect(() => validateSchedule({ kind: 'daily', hour: 9, minute: 0, ms: 1000 })).toThrow();
    expect(() => validateSchedule({ kind: 'daily', hour: 9, minute: 0, ms: -1 })).toThrow();
  });

  it('a non-numeric ms is rejected rather than silently ignored', () => {
    expect(() => validateSchedule({ kind: 'daily', hour: 9, minute: 0, ms: 'x' })).toThrow();
  });

  it('a millisecond target turns on precise timing', () => {
    expect(wantsPreciseTiming({ kind: 'daily', hour: 9, minute: 0, ms: 500 })).toBe(true);
    expect(wantsPreciseTiming({ kind: 'daily', hour: 9, minute: 0 })).toBe(false);
    expect(wantsPreciseTiming({ kind: 'daily', hour: 9, minute: 0, second: 30 })).toBe(true);
  });
});
