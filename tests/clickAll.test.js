/**
 * The behaviour of "click every match", with no browser involved.
 *
 * These tests are the contract for a feature whose whole purpose is a count and an order, so they assert on
 * counts and orders rather than on "it ran without throwing". The important cases are the ones that would
 * silently do the wrong thing on a live page: a list that shrinks between clicks, a limit, and an error
 * part-way through.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_DEFAULTS, afterClick, describeAllClicks, nextIndex, normaliseAll, planClicks,
} from '../src/core/dom/clickAll.js';

describe('planning the clicks', () => {
  it('clicks all ten when there are ten matches', () => {
    const p = planClicks({ count: 10 });
    expect(p.count).toBe(10);
    expect(p.indices).toHaveLength(10);
  });

  it('reverse order counts down, which is why it survives a collapsing list', () => {
    // taking from the end means the indices still to come do not shift when one is removed
    expect(planClicks({ count: 5, order: 'reverse' }).indices).toEqual([4, 3, 2, 1, 0]);
  });

  it('forward order counts up', () => {
    expect(planClicks({ count: 3, order: 'forward' }).indices).toEqual([0, 1, 2]);
  });

  it('a limit stops early, and says how many it will do', () => {
    const p = planClicks({ count: 10, limit: 3 });
    expect(p.count).toBe(3);
    expect(p.indices).toEqual([9, 8, 7]);
  });

  it('a limit larger than the count is clamped to the count', () => {
    expect(planClicks({ count: 2, limit: 100 }).count).toBe(2);
  });

  it('no matches is a count of zero, not an error', () => {
    expect(planClicks({ count: 0 }).count).toBe(0);
    expect(planClicks({ count: 0 }).skipped).toBe('no matches');
    expect(planClicks({ count: -1 }).count).toBe(0);
    expect(planClicks({ count: NaN }).count).toBe(0);
  });

  it('one match works, which is the ordinary single-click case', () => {
    expect(planClicks({ count: 1 }).indices).toEqual([0]);
  });
});

describe('picking the next index as the list changes', () => {
  it('reverse always takes the last of what is left', () => {
    // the scenario: 10 buttons, click one, the page removes it, 9 remain. The last of the 9 is a DIFFERENT
    // button from the last of the 10, but it is still one that has not been clicked - which is the property
    // that matters. Counting forward would re-click the first one repeatedly.
    let remaining = 10;
    const clicked = [];
    let taken = 0;
    while (true) {
      const i = nextIndex({ taken, remaining, order: 'reverse', limit: 0 });
      if (i === null) break;
      clicked.push(i);
      remaining -= 1;      // the page removed the one that was clicked
      taken += 1;
      if (taken > 20) break;   // guard against a runaway test
    }
    expect(clicked).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(clicked).toHaveLength(10);
  });

  it('forward re-clicks the first one when the list collapses, which is why it is not the default', () => {
    let remaining = 10;
    const clicked = [];
    let taken = 0;
    while (true) {
      const i = nextIndex({ taken, remaining, order: 'forward', limit: 0 });
      if (i === null) break;
      clicked.push(i);
      remaining -= 1;
      taken += 1;
      if (taken > 5) break;
    }
    // this is the failure mode being avoided: index 0 every time
    expect(new Set(clicked).size).toBe(1);
    expect(clicked[0]).toBe(0);
  });

  it('as-is walks up but stops when the list is shorter than the count taken', () => {
    expect(nextIndex({ taken: 0, remaining: 3, order: 'as-is' })).toBe(0);
    expect(nextIndex({ taken: 2, remaining: 3, order: 'as-is' })).toBe(2);
    expect(nextIndex({ taken: 3, remaining: 3, order: 'as-is' })).toBeNull();
  });

  it('respects the limit', () => {
    expect(nextIndex({ taken: 2, remaining: 10, order: 'reverse', limit: 3 })).toBe(9);
    expect(nextIndex({ taken: 3, remaining: 8, order: 'reverse', limit: 3 })).toBeNull();
  });

  it('stops when nothing is left', () => {
    expect(nextIndex({ taken: 5, remaining: 0, order: 'reverse' })).toBeNull();
    expect(nextIndex({ taken: 5, remaining: NaN, order: 'reverse' })).toBeNull();
  });
});

describe('after a click fails', () => {
  it('stops by default, because on an order page continuing is worse', () => {
    expect(afterClick({ succeeded: false, taken: 3, total: 10 }).action).toBe('stop');
    expect(afterClick({ succeeded: false, taken: 3, total: 10 }).reason).toMatch(/click 3 of 10 failed/);
  });

  it('continues when the step says to', () => {
    expect(afterClick({ succeeded: false, taken: 1, total: 4, onErrorPolicy: 'continue' }).action).toBe('continue');
    expect(afterClick({ succeeded: false, taken: 1, total: 4, onErrorPolicy: 'skip' }).action).toBe('continue');
  });

  it('a success always continues', () => {
    expect(afterClick({ succeeded: true, taken: 9, total: 10 }).action).toBe('continue');
  });
});

describe('what History says', () => {
  it('distinguishes a complete run from one that stopped early', () => {
    expect(describeAllClicks({ clicked: 10, total: 10 })).toBe('all 10 clicked');
    expect(describeAllClicks({ clicked: 4, total: 10, stoppedEarly: true, reason: 'click 5 of 10 failed' }))
      .toContain('4 of 10 clicked, then stopped');
  });

  it('says so when nothing matched, rather than reporting a success of zero', () => {
    expect(describeAllClicks({ clicked: 0, total: 0 })).toBe('nothing matched');
  });

  it('speaks Persian when the UI does, and keeps WESTERN DIGITS', () => {
    // The test originally asserted on Persian-Indic digits and failed - the code was right and the assertion
    // was wrong. Numbers stay Western in this project by explicit preference: they are what the user's
    // exchange, broker statements and terminal all use, and mixing numeral systems in one screen invites
    // misreading an order size. Pinned here so a later "helpful" conversion does not quietly change it.
    const fa3 = describeAllClicks({ clicked: 3, total: 3, language: 'fa' });
    expect(fa3).toMatch(/[\u0600-\u06FF]/);       // it is Persian
    expect(fa3).toContain('3');                    // the digit stays Latin
    expect(fa3).not.toMatch(/[\u06F0-\u06F9]/);    // and is NOT ۰-۹
  });
});

describe('normalising stored values', () => {
  it('defaults are sane', () => {
    const n = normaliseAll({});
    expect(n.order).toBe('reverse');
    expect(n.limit).toBe(0);
    expect(n.gapMs).toBe(ALL_DEFAULTS.gapMs);
  });

  it('an unknown order falls back rather than breaking the walk', () => {
    expect(normaliseAll({ order: 'sideways' }).order).toBe('reverse');
  });

  it('a gap below the floor is raised, because a page needs a moment to process a click', () => {
    expect(normaliseAll({ gapMs: 0 }).gapMs).toBe(50);
    expect(normaliseAll({ gapMs: -100 }).gapMs).toBe(50);
  });

  it('a negative or nonsense limit becomes "all"', () => {
    expect(normaliseAll({ limit: -5 }).limit).toBe(0);
    expect(normaliseAll({ limit: 'abc' }).limit).toBe(0);
  });

  it('a huge limit is clamped, so one bad value cannot pin the browser', () => {
    expect(normaliseAll({ limit: 1e9 }).limit).toBe(5000);
  });

  it('returns null for no configuration at all, so the caller knows the feature is off', () => {
    expect(normaliseAll(null)).toBeNull();
    expect(normaliseAll(undefined)).toBeNull();
    expect(normaliseAll('yes')).toBeNull();
  });
});
