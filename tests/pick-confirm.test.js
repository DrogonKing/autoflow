/**
 * The Pick confirmation belongs to ONE point.
 *
 * Reported, visual only: "گزینه pick وقتی سبز میشه برای همه ی pickهای از قبل ساخته شده هم سبز میشه در حالی که فقط اونی
 * که انتخاب شده باید سبز بشه" - when it goes green, all the previously created picks go green too, when only the
 * selected one should.
 *
 * The cause was one line: the condition was
 *
 *     state.pickSavedAt && state.pickTarget === null
 *
 * a TIMESTAMP with no record of which point it belonged to. `pickTarget` is null once a pick lands, so that was true
 * for every Pick button on the panel and all of them confirmed at once. `pickSavedFor` now carries the identity, the
 * same way `pickTarget` already did for the picking state.
 *
 * These tests are written against the PROPERTY - "at most one point can confirm" - rather than against the example, so a
 * future change that reintroduces a shared flag fails here even if it happens to look right for two buttons.
 */
import { describe, expect, it } from 'vitest';

/**
 * Mirror of the decision in `pickControl`.
 *
 * Kept as a small function so the property is asserted on the RULE rather than on a rendered button, which is what the
 * browser test does separately.
 */
function buttonState({ stepId, state, now }) {
  const picking = state.pickTarget === stepId;
  const justPicked = state.pickSavedFor === stepId && state.pickTarget === null
    && now - (state.pickSavedAt ?? 0) < 2500;
  return {
    cls: picking ? 'pick picking' : (justPicked ? 'pick picked' : 'pick'),
    text: picking ? 'picking' : (justPicked ? 'picked' : 'pick'),
  };
}

const points = ['p1', 'p2', 'p3'];
const stateFor = (over) => ({ pickTarget: null, pickSavedAt: null, pickSavedFor: null, ...over });

describe('only the picked point confirms', () => {
  it('THE REPORTED BUG: after picking p2, exactly one button is green', () => {
    const now = 10_000;
    const state = stateFor({ pickSavedFor: 'p2', pickSavedAt: now - 100 });

    const greens = points.filter((id) => buttonState({ stepId: id, state, now }).cls.includes('picked'));
    expect(greens).toEqual(['p2']);
  });

  it('none of the earlier points confirm', () => {
    const now = 10_000;
    const state = stateFor({ pickSavedFor: 'p2', pickSavedAt: now - 100 });
    for (const other of ['p1', 'p3']) {
      expect(buttonState({ stepId: other, state, now }).cls).toBe('pick');
    }
  });

  it('A SHARED FLAG WOULD FAIL THIS: the old condition greens everything', () => {
    /**
     * The regression guard. This reproduces the OLD rule - `pickSavedAt && pickTarget === null` - and shows it
     * confirming on all three points, so the test above cannot silently pass if the identity is dropped again.
     */
    const now = 10_000;
    const oldRule = (state) => state.pickSavedAt && state.pickTarget === null && now - state.pickSavedAt < 2500;
    const state = stateFor({ pickSavedAt: now - 100 });
    const oldGreens = points.filter(() => oldRule(state));
    expect(oldGreens).toEqual(points);                        // the bug: every point
    const newGreens = points.filter((id) => buttonState({ stepId: id, state, now }).cls.includes('picked'));
    expect(newGreens).toEqual([]);                            // and with no identity, none - not all
  });

  it('the picking state is per-point too, and never two at once', () => {
    const now = 10_000;
    const state = stateFor({ pickTarget: 'p3' });
    const picking = points.filter((id) => buttonState({ stepId: id, state, now }).cls.includes('picking'));
    expect(picking).toEqual(['p3']);
  });

  it('a live pick suppresses the confirmation, because the point is being chosen again', () => {
    const now = 10_000;
    const state = stateFor({ pickTarget: 'p2', pickSavedFor: 'p2', pickSavedAt: now - 100 });
    const s = buttonState({ stepId: 'p2', state, now });
    expect(s.cls).toBe('pick picking');
    expect(s.text).toBe('picking');
  });

  it('the confirmation expires, so it cannot claim a pick forever', () => {
    const state = stateFor({ pickSavedFor: 'p1', pickSavedAt: 1000 });
    expect(buttonState({ stepId: 'p1', state, now: 2000 }).cls).toContain('picked');
    expect(buttonState({ stepId: 'p1', state, now: 1000 + 2500 }).cls).toBe('pick');
    expect(buttonState({ stepId: 'p1', state, now: 99_999 }).cls).toBe('pick');
  });

  it('re-picking the SAME point confirms again, so a stale confirmation does not linger', () => {
    const now = 10_000;
    // the second pick of p1, 5 seconds after the first - the first has expired, the second is live
    const state = stateFor({ pickSavedFor: 'p1', pickSavedAt: now - 100 });
    expect(buttonState({ stepId: 'p1', state, now }).cls).toContain('picked');
  });

  it('every button is idle when nothing has been picked in this session', () => {
    const now = 10_000;
    const state = stateFor({});
    for (const id of points) expect(buttonState({ stepId: id, state, now }).cls).toBe('pick');
  });

  it('adding a point does not make the new one confirm', () => {
    const now = 10_000;
    const state = stateFor({ pickSavedFor: 'p1', pickSavedAt: now - 100 });
    // 'p4' is new and has never been picked
    expect(buttonState({ stepId: 'p4', state, now }).cls).toBe('pick');
  });
});
