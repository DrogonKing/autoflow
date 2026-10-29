/**
 * The diagnostic log and its export.
 *
 * The reason this exists: three attempts at "one click in eight did not happen" were resolved by reading code and
 * guessing which path was taken. An alarm that never fired, one that fired but found the slot busy, and one whose
 * step failed were indistinguishable from the run history, and the first left no record at all. These tests pin the
 * properties that make the export answer that question instead of adding another thing to read.
 */
import { describe, expect, it } from 'vitest';
import { MAX_EVENTS, decisionTrail, pushEvent, summarise } from '../src/core/diag/events.js';
import { buildExport, buildHeader, buildDecisionLines, exportAsText, stamp } from '../src/core/diag/report.js';

describe('the event log is bounded', () => {
  it('drops the OLDEST when full, so the latest evidence survives', () => {
    let events = [];
    for (let i = 0; i < MAX_EVENTS + 50; i++) events = pushEvent(events, { kind: 'x', n: i });
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events[0].n).toBe(50);
    expect(events[events.length - 1].n).toBe(MAX_EVENTS + 49);
  });

  it('stamps an event that arrives without a time', () => {
    const before = Date.now();
    const [e] = pushEvent([], { kind: 'a' });
    expect(e.at).toBeGreaterThanOrEqual(before);
    expect(e.at).toBeLessThanOrEqual(Date.now());
  });

  it('keeps an explicit time, because an imported event must not be re-stamped', () => {
    const [e] = pushEvent([], { kind: 'a', at: 12345 });
    expect(e.at).toBe(12345);
  });

  it('tolerates a corrupt store instead of throwing', () => {
    expect(pushEvent(null, { kind: 'a' })).toHaveLength(1);
    expect(pushEvent(undefined, { kind: 'a' })).toHaveLength(1);
    expect(pushEvent('nonsense', { kind: 'a' })).toHaveLength(1);
  });

  it('does not mutate the array it was given', () => {
    const original = [{ kind: 'a', at: 1 }];
    const next = pushEvent(original, { kind: 'b' });
    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
  });
});

describe('the decision trail is what a person reads first', () => {
  it('keeps the decisions and drops the noise', () => {
    const events = [
      { kind: 'alarm-armed', automationId: 'a', at: 1 },
      { kind: 'something-uninteresting', at: 2 },
      { kind: 'alarm-fired', automationId: 'a', at: 3 },
      { kind: 'start-accepted', automationId: 'a', at: 4 },
      { kind: 'run-finished', automationId: 'a', at: 5 },
    ];
    const trail = decisionTrail(events);
    expect(trail).toHaveLength(4);
    expect(trail.map((e) => e.kind)).toEqual(['alarm-armed', 'alarm-fired', 'start-accepted', 'run-finished']);
  });

  it('summarises counts by kind', () => {
    const s = summarise([{ kind: 'a' }, { kind: 'a' }, { kind: 'b' }]);
    expect(s.count).toBe(3);
    expect(s.byKind).toEqual({ a: 2, b: 1 });
  });
});

describe('times are formatted so two machines can be compared', () => {
  it('is HH:MM:SS.mmm', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 67);
    expect(stamp(d.getTime())).toBe('03:04:05.067');
  });

  it('a missing time is a dash, not NaN', () => {
    expect(stamp(undefined)).toBe('-');
    expect(stamp(NaN)).toBe('-');
  });
});

describe('the export answers the missing-click question', () => {
  const header = buildHeader({ version: '1.4.1', browser: 'chrome', platform: 'linux', now: 1000, timezoneOffsetMin: -210 });

  it('names the build, because the first report arrived against an unknown version', () => {
    expect(header.autoflowVersion).toBe('1.4.1');
    expect(header.browser).toBe('chrome');
  });

  it('records the timezone, because a schedule is a local wall-clock time', () => {
    expect(header.timezoneOffsetMin).toBe(-210);
  });

  it('puts the decisions at the top of the export', () => {
    const doc = buildExport({
      header,
      events: [
        { kind: 'alarm-armed', automationId: 'a', at: 10 },
        { kind: 'alarm-fired', automationId: 'a', at: 20 },
        { kind: 'start-queued', automationId: 'a', behind: 'b', depth: 2, at: 30 },
        { kind: 'start-accepted', automationId: 'a', steps: 1, tabId: 7, at: 40 },
      ],
      runs: [], automations: [], alarms: [], settings: {},
    });
    expect(doc.decisionTrail).toHaveLength(4);
    expect(Object.keys(doc)[0]).toBe('header');
    expect(Object.keys(doc)[1]).toBe('decisionTrail');
  });

  it('shows a refusal with its reason, not silently', () => {
    const lines = buildDecisionLines([
      { kind: 'start-refused', automationId: 'a', reason: 'slot busy with b after 3 waits', at: 5 },
    ]);
    expect(lines[0]).toContain('REFUSED');
    expect(lines[0]).toContain('slot busy with b after 3 waits');
  });

  it('shows a queued start, which is the difference between waiting and being dropped', () => {
    const lines = buildDecisionLines([
      { kind: 'start-queued', automationId: 'a', behind: 'b', depth: 1, at: 5 },
    ]);
    expect(lines[0]).toContain('QUEUED');
    expect(lines[0]).toContain('behind b');
  });

  it('shows a late fire with how late', () => {
    const lines = buildDecisionLines([{ kind: 'alarm-late', automationId: 'a', lateByMs: 4200, at: 5 }]);
    expect(lines[0]).toContain('FIRED LATE');
    expect(lines[0]).toContain('4200ms');
  });

  it('renders as text with the decisions before the detail', () => {
    const doc = buildExport({
      header,
      events: [{ kind: 'alarm-fired', automationId: 'a', at: 20 }],
      runs: [{ automationId: 'a', reason: 'finished', steps: 1, startedAt: 20, trace: [{ kind: 'click', how: '#buy' }] }],
      automations: [{ id: 'a', name: 'order', enabled: true, schedule: { kind: 'daily', hour: 9, minute: 0, second: 3 }, steps: [{}] }],
      alarms: [{ name: 'autoflow:a', scheduledTime: 99 }],
      settings: { a: 1 },
      pageLogs: [{ url: 'file:///test.html', clicks: [{ at: '22:10:00:02', target: 'نقطه ۵', delta: 10 }] }],
    });
    const text = exportAsText(doc);
    expect(text.indexOf('start decisions')).toBeLessThan(text.indexOf('-- runs'));
    expect(text).toContain('alarm-fired');
    expect(text).toContain('09:00:03');
    expect(text).toContain('نقطه ۵');
    expect(text).toContain('1.4.1');
  });

  it('says so plainly when the test page log is absent, instead of omitting the section', () => {
    const text = exportAsText(buildExport({ header, events: [], runs: [], automations: [], alarms: [], settings: {} }));
    expect(text).toContain('the test field was not open');
  });

  it('survives empty input without throwing', () => {
    expect(() => exportAsText(buildExport({}))).not.toThrow();
  });
});
