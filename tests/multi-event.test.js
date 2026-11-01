/**
 * Several timed events, each with its own points.
 *
 * The refusals and the round trips are the substance here, as with the other model tests: a save that loses a point, or
 * a merge that deletes an automation it does not own, is not visible in a size measurement or a screenshot.
 */
import { describe, expect, it } from 'vitest';
import {
  describeEvent,
  emptyPoint,
  eventIsReady,
  filledPoints,
  makeEvent,
  merge,
  orderByNextRun,
  split,
} from '../src/core/model/events.js';
import { nextRun } from '../src/core/schedule/schedule.js';

const saved = (over = {}) => ({
  id: 'basic',
  name: 'Basic',
  enabled: true,
  schedule: { kind: 'daily', hour: 10, minute: 32, second: 33, ms: 250 },
  steps: [
    { id: 'basic-point-1', kind: 'click', finder: { strategy: 'id', id: 'buy' } },
    { id: 'basic-point-2', kind: 'click', finder: { strategy: 'id', id: 'confirm' } },
  ],
  ...over,
});

describe('split: one record into several events', () => {
  it("keeps the request's shape: the first event has the original time and points", () => {
    const events = split(saved(), { extraTimes: [] });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('basic');
    expect(describeEvent(events[0].schedule)).toBe('10:32:33.250');
    expect(events[0].steps).toHaveLength(2);
  });

  it('the FIRST event keeps the original id, so an armed alarm is not orphaned', () => {
    const events = split(saved(), { extraTimes: [{ id: 'basic-t1', schedule: { kind: 'daily', hour: 10, minute: 32, second: 40, ms: 0 } }] });
    expect(events[0].id).toBe('basic');
    expect(events[1].id).toBe('basic-t1');
  });

  it('an empty record still yields one event with one empty point', () => {
    const events = split({ id: 'basic' });
    expect(events).toHaveLength(1);
    expect(events[0].steps).toHaveLength(1);
    expect(eventIsReady(events[0])).toBe(false);
  });

  it('carries the urls on the first event only, because they decide where it runs', () => {
    const events = split(saved({ urls: ['https://example.test/'] }), {
      extraTimes: [{ id: 'basic-t1', schedule: { kind: 'daily', hour: 11, minute: 0, second: 0 } }],
    });
    expect(events[0].urls).toEqual(['https://example.test/']);
    expect(events[1].urls).toBeUndefined();
  });
});

describe('merge: events into records', () => {
  const ev = (hour, minute, second, ms, points) => ({
    id: `x-${hour}`,
    schedule: { kind: 'daily', hour, minute, second, ms },
    name: '',
    steps: Array.from({ length: points }, (_, i) => ({ id: null, kind: 'click', finder: { strategy: 'id', id: `e${i}` } })),
  });

  it("stores the request's three events as three records", () => {
    const events = [ev(10, 32, 33, 250, 4), ev(10, 32, 40, 0, 3), ev(10, 35, 0, 0, 5)];
    const { save } = merge('basic', events, { template: { name: 'Basic' } });
    expect(save).toHaveLength(3);
    // the fraction is shown only when there is one, so the two whole-second events print without it
    expect(save.map((a) => describeEvent(a.schedule))).toEqual(['10:32:33.250', '10:32:40', '10:35:00']);
    expect(save.map((a) => a.steps.length)).toEqual([4, 3, 5]);
  });

  it('keeps each event\'s OWN id, so a deletion cannot renumber the others', () => {
    // NOTE: `ev()` builds an event with a synthetic id (`x-<hour>`), so the FIRST event keeps `x-10` rather than being
    // relabelled `basic`. That relabelling was the bug: it made the removal set point at the wrong record.
    /**
     * This test used to assert `['basic','basic-t1','basic-t2']` - ids derived from the POSITION in the list - and that
     * was describing a bug rather than a decision. MEASURED (`remove-time-test`): deleting the middle time renumbered
     * the one after it, from `basic-t2` to `basic-t1`, and an alarm registered as `autoflow:run:basic-t1` silently began
     * pointing at a different time.
     */
    const events = [ev(10, 0, 0, 0, 1), { ...ev(11, 0, 0, 0, 1), id: 'basic-t7' }, { ...ev(12, 0, 0, 0, 1), id: 'basic-t9' }];
    const { save } = merge('basic', events, { template: { name: 'Basic' } });
    expect(save.map((x) => x.id)).toEqual(['x-10', 'basic-t7', 'basic-t9']);
  });

  it('gives the same ids on a second merge, so an armed alarm is not orphaned', () => {
    const events = [ev(10, 0, 0, 0, 1), { ...ev(11, 0, 0, 0, 1), id: 'basic-t4' }, { ...ev(12, 0, 0, 0, 1), id: 'basic-t8' }];
    const a = merge('basic', events, { template: { name: 'Basic' } });
    const b = merge('basic', events, { template: { name: 'Basic' } });
    expect(b.save.map((x) => x.id)).toEqual(a.save.map((x) => x.id));
  });

  it('an event with NO id falls back to its index, so merge cannot emit undefined', () => {
    const events = [{ schedule: { kind: 'daily', hour: 9, minute: 0, second: 0 }, steps: [{ id: 'p', kind: 'click', finder: { strategy: 'id', id: 'a' } }] },
      { schedule: { kind: 'daily', hour: 10, minute: 0, second: 0 }, steps: [{ id: 'p', kind: 'click', finder: { strategy: 'id', id: 'b' } }] }];
    const { save } = merge('basic', events, { template: {} });
    expect(save.map((x) => x.id)).toEqual(['basic', 'basic-t1']);
  });

  it('gives every point an id, so the pick machinery has something to target', () => {
    const { save } = merge('basic', [ev(9, 0, 0, 0, 3)], { template: { name: 'Basic' } });
    expect(save[0].steps.every((s) => typeof s.id === 'string' && s.id.length > 0)).toBe(true);
    expect(new Set(save[0].steps.map((s) => s.id)).size).toBe(3);
  });

  it('keeps a field the Basic form does not edit, by spreading the template first', () => {
    const { save } = merge('basic', [ev(9, 0, 0, 0, 1)], { template: { name: 'Basic', options: { speed: 'fast' }, enabled: false } });
    expect(save[0].options).toEqual({ speed: 'fast' });
  });

  it('always stores enabled: true, because a saved event that is off would never fire', () => {
    const { save } = merge('basic', [ev(9, 0, 0, 0, 1)], { template: { enabled: false } });
    expect(save[0].enabled).toBe(true);
  });

  it('REPORTS the ids to remove, so deleting the last event is expressible', () => {
    // an event with no id of its own takes `baseId` at position 0 - the fallback for a form never rendered before
    const bare = { schedule: { kind: 'daily', hour: 9, minute: 0, second: 0 }, steps: [{ id: 'p', kind: 'click', finder: { strategy: 'id', id: 'a' } }] };
    const { save, remove } = merge('basic', [bare], {
      template: { name: 'Basic', knownIds: ['basic', 'basic-t1', 'basic-t2'] },
    });
    expect(save.map((a) => a.id)).toEqual(['basic']);
    expect(remove.sort()).toEqual(['basic-t1', 'basic-t2']);
  });

  it('never removes an automation this form does not own', () => {
    const bare = { schedule: { kind: 'daily', hour: 9, minute: 0, second: 0 }, steps: [{ id: 'p', kind: 'click', finder: { strategy: 'id', id: 'a' } }] };
    const { remove } = merge('basic', [bare], {
      template: { name: 'Basic', knownIds: ['basic', 'basic-t1', 'a-later-automation', 'basicness-other'] },
    });
    // 'a-later-automation' belongs to the full editor; 'basicness-other' merely starts with the same letters
    expect(remove).toEqual(['basic-t1']);
  });

  it('names later events apart from the first, so the history is readable', () => {
    const { save } = merge('basic', [ev(9, 0, 0, 0, 1), ev(10, 0, 0, 0, 1)], { template: { name: 'Basic' } });
    expect(save[0].name).toBe('Basic');
    expect(save[1].name).toBe('Basic 2');
  });

  it('prefers a name the user typed', () => {
    const named = { ...ev(9, 0, 0, 0, 1), name: '  open  ' };
    const { save } = merge('basic', [named], { template: { name: 'Basic' } });
    expect(save[0].name).toBe('open');
  });

  it('a schedule is always stored as a daily one, which is what this form edits', () => {
    const { save } = merge('basic', [{ ...ev(9, 0, 0, 0, 1), schedule: { kind: 'cron', expression: '* * * * *', hour: 9, minute: 0 } }], { template: {} });
    expect(save[0].schedule.kind).toBe('daily');
  });
});

describe('round trip', () => {
  it('split then merge reproduces what was there, id and points included', () => {
    const original = saved();
    const events = split(original, { extraTimes: [] });
    const { save, remove } = merge('basic', events, { template: { name: original.name, knownIds: ['basic'] } });
    expect(save).toHaveLength(1);
    expect(save[0].id).toBe('basic');
    expect(save[0].steps.map((s) => s.finder.id)).toEqual(['buy', 'confirm']);
    expect(describeEvent(save[0].schedule)).toBe('10:32:33.250');
    expect(remove).toEqual([]);
  });

  it('an EMPTY added point is dropped, which is what makes the refusal fire', () => {
    /**
     * This is the behaviour `save-button-test` caught and this test originally asserted the opposite of.
     *
     * A form with no usable point must reach storage as zero steps, because that is what triggers "at least one point is
     * needed" and stops the button claiming a save that would fail at run time. Asserting the empty point survived was
     * describing a bug.
     */
    const events = split(saved(), { extraTimes: [] });
    events[0].steps.push(emptyPoint('basic-point-3'));
    const { save } = merge('basic', events, { template: { name: 'Basic' } });
    expect(save[0].steps).toHaveLength(2);
    expect(save[0].steps.map((s) => s.finder.id)).toEqual(['buy', 'confirm']);
  });

  it('a point that was GIVEN a selector survives the round trip', () => {
    const events = split(saved(), { extraTimes: [] });
    events[0].steps.push({ id: 'basic-point-3', kind: 'click', finder: { strategy: 'id', id: 'third' } });
    const { save } = merge('basic', events, { template: { name: 'Basic' } });
    expect(save[0].steps).toHaveLength(3);
    expect(save[0].steps[2].finder.id).toBe('third');
  });

  it('an event with no usable point yields a record with NO steps, so the refusal can fire', () => {
    const empty = { id: 'e', schedule: { kind: 'daily', hour: 10, minute: 0, second: 0 }, name: '', steps: [emptyPoint('p1')] };
    const { save } = merge('basic', [empty], { template: { name: 'Basic' } });
    expect(save[0].steps).toHaveLength(0);
  });
});

describe('the summary helpers', () => {
  it('counts only points that name an element', () => {
    const e = makeEvent('basic', { kind: 'daily', hour: 9, minute: 0, second: 0 });
    expect(filledPoints(e)).toBe(0);
    e.steps.push({ id: 'p2', kind: 'click', finder: { strategy: 'id', id: 'x' } });
    expect(filledPoints(e)).toBe(1);
    expect(eventIsReady(e)).toBe(true);
  });

  it('describeEvent hides a zero fraction and shows a real one', () => {
    expect(describeEvent({ hour: 9, minute: 5, second: 0, ms: 0 })).toBe('09:05:00');
    expect(describeEvent({ hour: 10, minute: 32, second: 33, ms: 250 })).toBe('10:32:33.250');
    expect(describeEvent({ hour: 10, minute: 32, second: 33, ms: 50 })).toBe('10:32:33.050');
  });
});

describe('orderByNextRun', () => {
  it('orders by when they will ACTUALLY fire, not by the clock face', () => {
    // 23:50 fires before 00:10 tonight, even though 00:10 is the smaller number
    const now = new Date(2026, 9, 31, 20, 0, 0).getTime();
    const events = [
      makeEvent('e1', { kind: 'daily', hour: 0, minute: 10, second: 0 }),
      makeEvent('e2', { kind: 'daily', hour: 23, minute: 50, second: 0 }),
    ];
    const ordered = orderByNextRun(events, nextRun, now);
    expect(ordered.map((e) => e.id)).toEqual(['e2', 'e1']);
  });

  it('keeps the entered order for two events at the same instant', () => {
    const now = new Date(2026, 9, 31, 8, 0, 0).getTime();
    const events = [
      makeEvent('a', { kind: 'daily', hour: 10, minute: 0, second: 0 }),
      makeEvent('b', { kind: 'daily', hour: 9, minute: 0, second: 0 }),
    ];
    // they are different times, so the order is by instant: 9:00 first
    expect(orderByNextRun(events, nextRun, now).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('an unorderable event sorts last rather than throwing out the list', () => {
    const now = new Date(2026, 9, 31, 8, 0, 0).getTime();
    const events = [
      makeEvent('broken', { kind: 'daily', hour: 99, minute: 0, second: 0 }),
      makeEvent('fine', { kind: 'daily', hour: 9, minute: 0, second: 0 }),
    ];
    const ordered = orderByNextRun(events, nextRun, now);
    expect(ordered.map((e) => e.id)).toEqual(['fine', 'broken']);
  });
});
