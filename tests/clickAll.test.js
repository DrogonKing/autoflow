/**
 * "Click every match" where the matches DO NOT REMOVE THEMSELVES.
 *
 * The first version of this feature tracked a position and always took the last remaining one. Its test fixture
 * had buttons that deleted themselves on click, so the list shrank and "the last" moved each time - the test
 * passed. On the simulation page, whose buttons stay put, it clicked the same button 159 times until the run
 * timed out. On a real order page, which does not remove its buttons, that is 159 duplicate orders.
 *
 * The lesson is about the fixture, not the loop: a test whose page behaves helpfully can hide a bug that the
 * real page exposes. So this file uses both shapes - a list that shrinks and a list that does not - and asserts
 * the same outcome for both: each match pressed exactly once.
 */
import { describe, expect, it } from 'vitest';
import { afterClick, describeAllClicks, normaliseAll, pickNext, planClicks } from '../src/core/dom/clickAll.js';

/** A stand-in for a DOM element: only identity matters here. */
const el = (n) => ({ id: n });

describe('picking the next match by identity', () => {
  it('clicks each of ten staying-put matches exactly once', () => {
    // THE CASE THAT WAS BROKEN. The list is the same on every pass.
    const candidates = Array.from({ length: 10 }, (_, i) => el(i));
    const done = new Set();
    const clicked = [];

    for (let pass = 0; pass < 50; pass++) {
      const next = pickNext({ candidates, isVisited: (x) => done.has(x), order: 'reverse' });
      if (!next) break;
      clicked.push(next.id);
      done.add(next);
    }

    expect(clicked).toHaveLength(10);
    expect(new Set(clicked).size).toBe(10);
    expect(clicked.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('clicks each of ten matches that REMOVE THEMSELVES exactly once', () => {
    // the original fixture shape: the list shrinks, and identity still works
    let candidates = Array.from({ length: 10 }, (_, i) => el(i));
    const done = new Set();
    const clicked = [];

    for (let pass = 0; pass < 50; pass++) {
      const next = pickNext({ candidates, isVisited: (x) => done.has(x), order: 'reverse' });
      if (!next) break;
      clicked.push(next.id);
      done.add(next);
      candidates = candidates.filter((c) => c !== next);   // the page removes it
    }

    expect(clicked).toHaveLength(10);
    expect(new Set(clicked).size).toBe(10);
  });

  it('reverse order goes last to first', () => {
    const candidates = [el('a'), el('b'), el('c')];
    const done = new Set();
    const order = [];
    for (let i = 0; i < 3; i++) {
      const n = pickNext({ candidates, isVisited: (x) => done.has(x), order: 'reverse' });
      order.push(n.id); done.add(n);
    }
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('forward order goes first to last', () => {
    const candidates = [el('a'), el('b'), el('c')];
    const done = new Set();
    const order = [];
    for (let i = 0; i < 3; i++) {
      const n = pickNext({ candidates, isVisited: (x) => done.has(x), order: 'forward' });
      order.push(n.id); done.add(n);
    }
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('stops when every match has been clicked, rather than looping', () => {
    const candidates = [el('a'), el('b')];
    const done = new Set(candidates);
    expect(pickNext({ candidates, isVisited: (x) => done.has(x) })).toBeNull();
  });

  it('honours a limit', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => el(i));
    const done = new Set();
    for (let i = 0; i < 3; i++) { const n = pickNext({ candidates, isVisited: (x) => done.has(x), taken: i, limit: 3 }); done.add(n); }
    expect(done.size).toBe(3);
    expect(pickNext({ candidates, isVisited: (x) => done.has(x), taken: 3, limit: 3 })).toBeNull();
  });

  it('a re-created element counts as new, so a page that rebuilds its list still works', () => {
    // after a re-render the nodes are different objects; identity handles that without any special case
    const first = [el('x'), el('y')];
    const done = new Set([first[0]]);
    const rebuilt = [{ id: 'x-new' }, { id: 'y-new' }];
    expect(pickNext({ candidates: rebuilt, isVisited: (x) => done.has(x), order: 'forward' }))
      .toEqual({ id: 'x-new' });
  });

  it('an empty list is null, not an error', () => {
    expect(pickNext({ candidates: [], isVisited: () => false })).toBeNull();
    expect(pickNext({ candidates: null, isVisited: () => false })).toBeNull();
    expect(pickNext()).toBeNull();
  });

  it('a single match is clicked once and then stops', () => {
    const one = [el('only')];
    const done = new Set();
    const n1 = pickNext({ candidates: one, isVisited: (x) => done.has(x) });
    expect(n1).toEqual({ id: 'only' });
    done.add(n1);
    expect(pickNext({ candidates: one, isVisited: (x) => done.has(x) })).toBeNull();
  });
});

describe('the plan still describes what will happen', () => {
  it('ten matches means ten planned clicks', () => {
    expect(planClicks({ count: 10 }).count).toBe(10);
  });

  it('a limit caps the plan', () => {
    expect(planClicks({ count: 10, limit: 3 }).count).toBe(3);
  });

  it('no matches is a count of zero', () => {
    expect(planClicks({ count: 0 }).count).toBe(0);
  });
});

describe('stopping and reporting', () => {
  it('stops on a failure by default', () => {
    expect(afterClick({ succeeded: false, taken: 2, total: 10 }).action).toBe('stop');
  });

  it('continues when told to', () => {
    expect(afterClick({ succeeded: false, taken: 2, total: 10, onErrorPolicy: 'continue' }).action).toBe('continue');
  });

  it('reports a complete run and a partial one differently', () => {
    expect(describeAllClicks({ clicked: 10, total: 10 })).toBe('all 10 clicked');
    expect(describeAllClicks({ clicked: 4, total: 10, stoppedEarly: true, reason: 'boom' }))
      .toContain('4 of 10 clicked, then stopped');
  });

  it('speaks Persian and keeps Western digits', () => {
    const fa = describeAllClicks({ clicked: 3, total: 3, language: 'fa' });
    expect(fa).toMatch(/[\u0600-\u06FF]/);
    expect(fa).toContain('3');
    expect(fa).not.toMatch(/[\u06F0-\u06F9]/);
  });
});

describe('stored values', () => {
  it('the gap has a floor, because a page needs a moment', () => {
    expect(normaliseAll({ gapMs: 0 }).gapMs).toBe(50);
  });

  it('a nonsense limit means every match', () => {
    expect(normaliseAll({ limit: -1 }).limit).toBe(0);
    expect(normaliseAll({ limit: 'x' }).limit).toBe(0);
  });

  it('an unknown order falls back', () => {
    expect(normaliseAll({ order: 'sideways' }).order).toBe('reverse');
  });
});