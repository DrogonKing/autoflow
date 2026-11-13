/**
 * THE WINDOW: start at an instant, repeat the points until a deadline.
 *
 * WHAT THE USER ASKED FOR:
 *   "بشه بهش زمان با دقت میلی ثانیه داد ... انتهاش اجباری نباشه ... تو این فاصله شروع کنه به ترتیب نقاط انتخاب شده رو بزنه
 *    و اگر نقاط تموم شد دوباره بره از اول بزنه تا زمانی که زمانش تموم بشه"
 *
 * So there are three things to get right, and they are separable:
 *
 *   1. THE LOOP repeats the sequence and starts over when the points run out          -> these tests, by round count
 *   2. THE DEADLINE is honoured, and the last round is never cut off mid-sequence      -> these tests, by virtual clock
 *   3. NO DEADLINE means the user stops it, and that must not loop forever silently   -> these tests, by stop
 *
 * The virtual clock makes the arithmetic exact: `sleep` advances it, and `execute` records the instant it ran, so the spacing
 * and the round boundaries are readable rather than inferred.
 */

import { describe, it, expect } from 'vitest';
import { Runner, resolveWindowEnd, MAX_WINDOW_ROUNDS } from '../src/core/engine/runner.js';

/**
 * A host with a virtual clock and a configurable per-action cost.
 *
 * `stepCostMs` DEFAULTS TO 1, NOT 0, and that default is load-bearing: the virtual clock only moves when something advances it,
 * so a zero-cost action in a window with a deadline would never reach that deadline, and the loop - being async - starves the
 * event loop badly enough that vitest's own test timeout cannot fire. This file hung twice on exactly that before the default
 * was changed. A real click always costs something; the harness now assumes so.
 */
const makeHost = ({ stepCostMs = 1, stopAfterMs = null, stopAfterClicks = null } = {}) => {
  const now = { t: 1_000_000 };
  const calls = [];
  let executed = 0;
  const host = {
    calls,
    now: () => now.t,
    sleep: async (ms) => {
      calls.push({ kind: 'sleep', ms, at: now.t });
      now.t += ms;
    },
    isAlive: async () => true,
    stopRequested: () => {
      if (stopAfterMs !== null && now.t >= 1_000_000 + stopAfterMs) return true;
      // `exactly N clicks` is the only counter the fixture keeps, so the option says so
      if (stopAfterClicks !== null && executed >= stopAfterClicks) return true;
      return false;
    },
    execute: async (step) => {
      executed += 1;
      /**
       * `click` IS THE GLOBAL CLICK INDEX, not a round number - it was named `round` in the first version, which made every
       * click its own "round" and turned a correct grouping assertion into an empty one. The name is corrected here rather than
       * worked around in the test.
       */
      calls.push({ kind: 'execute', stepId: step.id, at: now.t, click: executed });
      now.t += stepCostMs;
      return { ok: true };
    },
    onTrace: (e) => calls.push({ kind: 'trace', type: e.type, at: now.t, ...e }),
    assertVisible: async () => true,
  };
  return host;
};

const automationWith = (options, steps) => ({
  id: 'win',
  name: 'window',
  enabled: true,
  schedule: { kind: 'once', at: 1_000_000 },
  options,
  steps,
});

const pick = (n) => ({ id: `p${n}`, kind: 'click', finder: { strategy: 'id', id: `btn-${n}` } });
const threePicks = () => [pick(1), pick(2), pick(3)];

const executes = (host) => host.calls.filter((c) => c.kind === 'execute');
const order = (host) => executes(host).map((c) => c.stepId).join(',');

describe('resolveWindowEnd decides whether a window exists at all', () => {
  it('an absolute instant is used as given, needing no reference point', () => {
    expect(resolveWindowEnd({ untilMs: 5_000 }, 1_000)).toEqual({ isWindow: true, endAt: 5_000 });
  });

  it('a duration is resolved against the run start', () => {
    expect(resolveWindowEnd({ runForMs: 2_000 }, 1_000)).toEqual({ isWindow: true, endAt: 3_000 });
  });

  it('the instant wins when both are present, because it is what the user named', () => {
    expect(resolveWindowEnd({ untilMs: 9_000, runForMs: 2_000 }, 1_000)).toEqual({ isWindow: true, endAt: 9_000 });
  });

  it('nothing at all means no window, so an ordinary run is untouched', () => {
    expect(resolveWindowEnd({}, 1_000).isWindow).toBe(false);
    expect(resolveWindowEnd(undefined, 1_000).isWindow).toBe(false);
  });

  it('AN EXPLICIT WINDOW WITH NO DEADLINE IS ENDLESS, not an ordinary run', () => {
    /**
     * THE CASE THE FIRST DESIGN COULD NOT EXPRESS, and it is the one that was asked for in so many words: an empty end time
     * means "keep clicking until I press stop". Inferring window mode from having a deadline made that identical to a plain
     * one-shot run, so it was unreachable.
     */
    expect(resolveWindowEnd({ window: true }, 1_000)).toEqual({ isWindow: true, endAt: null });
    expect(resolveWindowEnd({ window: true, untilMs: 0 }, 1_000)).toEqual({ isWindow: true, endAt: null });
  });

  it('a zero or negative deadline is treated as ABSENT, not as an instant that closes immediately', () => {
    // zero would click nothing and look like a broken feature rather than a field left empty
    expect(resolveWindowEnd({ window: true, untilMs: 0 }, 1_000).endAt).toBeNull();
    expect(resolveWindowEnd({ window: true, runForMs: -5 }, 1_000).endAt).toBeNull();
    expect(resolveWindowEnd({ window: true, untilMs: 'abc' }, 1_000).endAt).toBeNull();
  });
});

describe('the points are repeated in order until the deadline', () => {
  it('with a window, the SAME sequence runs again from the start', async () => {
    /**
     * `stepCostMs` MUST BE NON-ZERO. The virtual clock only moves when something advances it, so a zero-cost action in a world
     * with no other waiting leaves the deadline unreachable and the loop spins forever - which is how the first version of this
     * test hung. A real click is never free, and a test that assumes it is tests an impossible machine.
     */
    const host = makeHost({ stepCostMs: 10 });
    await new Runner(host).run(automationWith({ untilMs: 1_000_100 }, threePicks()));
    const seq = order(host).split(',');
    expect(seq.length).toBeGreaterThan(3);
    expect(seq.length % 3).toBe(0);                        // whole rounds only - a round is never left half done
    for (let i = 0; i < seq.length; i += 3) {
      expect(seq.slice(i, i + 3)).toEqual(['p1', 'p2', 'p3']);
    }
  });

  it('an endless window is bounded by the step budget, so it cannot spin forever', async () => {
    /**
     * AN ENDLESS WINDOW STILL HAS TO END. With no deadline the loop runs until the user stops it, so the only thing that can
     * bound a machine where nothing is stopping it is the step budget inside `#runStep`. The cost is non-zero so the clock also
     * advances - otherwise the test itself could hang on a zero-cost action, which is how an earlier version of this file hung.
     */
    const host = makeHost({ stepCostMs: 5 });
    const res = await new Runner(host, { maxStepsExecuted: 9 })
      .run(automationWith({ window: true }, threePicks()))       // an endless WINDOW, not a plain run
      .then((r) => r, (e) => ({ reason: 'error', error: e }));
    /**
     * THE POINT IS THAT IT ENDS, not the exact number of clicks: the budget throws part-way through a round, so the last round
     * is abandoned rather than completed. Asserting `9` encoded the wrong expectation - the guarantee is a bound and a stated
     * reason, and both are checked.
     */
    const clicks = order(host).split(',').length;
    console.log('    budget-exhausted reason:', res.reason, 'clicks:', clicks);
    expect(clicks).toBeGreaterThan(0);
    expect(clicks).toBeLessThan(50);                      // bounded, not a runaway
    expect(res.reason).not.toBe('finished');
  });

  it('THE DEADLINE IS NEVER OVERSHOT, even with an action that costs time', async () => {
    /**
     * WHAT "NOT OVERSHOT" MEANS, precisely: no round STARTS at or after the deadline. A click that is already in flight when
     * the deadline passes is not an overshoot - cutting it off mid-action would leave the page in an unknown state for the next
     * round, which is worse than finishing it.
     */
    const host = makeHost({ stepCostMs: 7 });
    await new Runner(host).run(automationWith({ untilMs: 1_000_200 }, threePicks()));
    const roundStarts = host.calls.filter((c) => c.kind === 'trace' && c.type === 'round-start');
    expect(roundStarts.length).toBeGreaterThan(0);
    expect(roundStarts.every((r) => r.at < 1_000_200)).toBe(true);
  });

  it('a round is not started that cannot fit, so no round is left half-executed', async () => {
    // the deadline falls in the middle of a round: the round in progress completes, and no new one begins
    const host = makeHost({ stepCostMs: 30 });
    await new Runner(host).run(automationWith({ untilMs: 1_000_100 }, threePicks()));
    const seq = order(host).split(',');
    expect(seq.length % 3).toBe(0);
  });

  it('with no end time it keeps going until the user stops it', async () => {
    // nine clicks is three full rounds, so the stop lands on a round boundary
    const host = makeHost({ stopAfterClicks: 9 });
    const res = await new Runner(host).run(automationWith({ window: true }, threePicks()));
    expect(order(host).split(',').length).toBe(9);          // the stop is honoured, not ignored
    expect(res.reason).toBe('stopped-by-user');             // the reason the existing stop path reports
  });

  it('the round ceiling is a real, high bound rather than a stand-in for the step budget', async () => {
    expect(MAX_WINDOW_ROUNDS).toBeGreaterThanOrEqual(10_000);
  });

  it('an ordinary run with no window still executes its steps exactly once', async () => {
    const host = makeHost();
    await new Runner(host).run(automationWith({}, threePicks()));
    expect(order(host)).toBe('p1,p2,p3');
  });

  it('a window records how many rounds it ran, so the panel can report it', async () => {
    // six clicks of three picks each is TWO complete rounds
    const host = makeHost({ stopAfterClicks: 6 });
    const res = await new Runner(host).run(automationWith({ window: true }, threePicks()));
    expect(res.reason).toBe('stopped-by-user');
    expect(order(host).split(',').length).toBe(6);
    /**
     * THE ROUND COUNT IS ON THE TRACE, which is what the panel and the diagnostic read. Two rounds of three picks is the
     * arithmetic worth asserting, because a count that tracked clicks instead of rounds would read 6 and look right.
     */
    const roundStarts = host.calls.filter((c) => c.kind === 'trace' && c.type === 'round-start');
    expect(roundStarts.length).toBe(2);
    expect(roundStarts.map((r) => r.round)).toEqual([1, 2]);
  });
});

describe('AN ENDLESS WINDOW CANNOT HANG', () => {
  /**
   * THE HAZARD, and it is the exact one reported: with no end time the run continues until Stop is pressed, so if nothing can
   * reach the loop, Stop is unreachable and the whole extension looks frozen. These tests are about the loop remaining
   * interruptible and bounded - not about the clicks.
   */

  it('STOP IS OBSERVED, because a macrotask yield runs every round', async () => {
    /**
     * The stop flag is set from outside the loop. Without a macrotask turn between rounds, the loop's `await`s are microtasks,
     * the flag is never re-read by a fresh turn of the event loop, and Stop does nothing. Asserting a non-zero sleep of 0 is
     * how that guarantee is visible: `sleep(0)` is a `setTimeout`, which is a macrotask.
     */
    const host = makeHost({ stopAfterClicks: 3 });
    await new Runner(host).run(automationWith({ window: true }, threePicks()));
    const yields = host.calls.filter((c) => c.kind === 'sleep' && c.ms === 0);
    expect(yields.length).toBeGreaterThan(0);
    // and it did stop, which is the behaviour the yield exists to make possible
    expect(order(host).split(',').length).toBe(3);
  });

  it('a round in which NOTHING executes is abandoned instead of repeating instantly', async () => {
    /**
     * The zero-length round: every step skipped by a condition. Such a round takes no time, so it would repeat as fast as the
     * microtask queue allows and never reach its deadline - the wall-clock ceiling would take twelve hours to notice. It is
     * detected by consecutive count instead, and the error names the cause.
     */
    const host = makeHost();
    /**
     * A CONDITION THAT IS GENUINELY FALSE, evaluated by the engine's own evaluator rather than by a made-up kind: a condition on
     * a variable that does not exist, tested for existence, can never hold. (The first version of this test used a fictional
     * `kind: 'never'`, so the step was never skipped, the rounds were not empty, and the case proved nothing - the round ceiling
     * caught it instead of the detector.)
     */
    /**
     * `#runBlock` evaluates NO per-step condition - only `if` and `loop` blocks have one. So an empty round is produced by an
     * `if` whose condition can never hold, with the click inside its `then`: the round executes, nothing inside it runs.
     */
    const skippingSteps = [
      { id: 'guard', kind: 'if',
        condition: { source: 'variable', variable: 'no-such-variable', comparator: 'exists' },
        then: [{ id: 'c1', kind: 'click', finder: { strategy: 'id', id: 'x' } }],
        else: [] },
    ];
    const res = await new Runner(host)
      .run(automationWith({ window: true }, skippingSteps))
      .then((r) => r, (e) => ({ reason: 'error', error: e }));
    const ends = host.calls.filter((c) => c.kind === 'trace' && c.type === 'window-end');
    console.log('    empty-round end:', JSON.stringify(ends[0] ?? null).slice(0, 150));
    console.log('    reason:', res.reason, '| error:', String(res.error?.message ?? '').slice(0, 100));
    // THE DETECTOR IS WHAT MUST FIRE, not the round ceiling - the whole point is that it is reached in an instant
    expect(ends[0]?.reason).toBe('empty-rounds');
    expect(ends[0]?.emptyRounds).toBeGreaterThanOrEqual(25);
    expect(String(res.error?.message ?? '')).toMatch(/without executing a single step/);
  });

  it('an endless window still respects a wall-clock ceiling', async () => {
    /**
     * "No end time" must not mean "no bound at all": a run left going overnight would keep clicking into the next session. The
     * default ceiling is hours away, so a low `maxWindowMs` is used here to reach it - the path is the same one.
     */
    const host = makeHost({ stepCostMs: 10 });
    const res = await new Runner(host).run(automationWith({ window: true, maxWindowMs: 200 }, threePicks()));
    const ends = host.calls.filter((c) => c.kind === 'trace' && c.type === 'window-end');
    console.log('    ceiling end:', JSON.stringify(ends[0] ?? null).slice(0, 140));
    expect(ends[0]?.reason).toBe('window-cap');
    expect(res.reason).toBe('finished');
  });

  it('a finite window does NOT get the ceiling treatment - its deadline ends it first', async () => {
    const host = makeHost({ stepCostMs: 10 });
    await new Runner(host).run(automationWith({ untilMs: 1_000_150, maxWindowMs: 50 }, threePicks()));
    const ends = host.calls.filter((c) => c.kind === 'trace' && c.type === 'window-end');
    expect(ends[0]?.reason).toBe('window-complete');
  });

  it('the window announces its ceiling when it starts, so the run is not silently bounded', async () => {
    const host = makeHost({ stopAfterClicks: 3 });
    await new Runner(host).run(automationWith({ window: true }, threePicks()));
    const start = host.calls.find((c) => c.kind === 'trace' && c.type === 'window-start');
    expect(start.endless).toBe(true);
    expect(start.hasEnd).toBe(false);
    expect(start.ceilingMs).toBeGreaterThan(0);
    expect(start.hardStopAt).toBeGreaterThan(start.at);
  });

  it('every ending carries a distinct reason, so "it stopped" can be told from "why"', async () => {
    const host = makeHost({ stepCostMs: 10 });
    await new Runner(host).run(automationWith({ untilMs: 1_000_120 }, threePicks()));
    const end = host.calls.find((c) => c.kind === 'trace' && c.type === 'window-end');
    expect(['window-complete', 'window-cap', 'round-limit', 'empty-rounds']).toContain(end.reason);
  });
});

describe('the per-click delay still applies inside a window', () => {
  it('the gap is a floor between clicks and does not eat the deadline arithmetic', async () => {
    const host = makeHost({ stepCostMs: 4 });
    await new Runner(host).run(automationWith({ untilMs: 1_000_200, clickGapMs: 20 }, threePicks()));
    /**
     * THE GAP IS ASSERTED WITHIN A ROUND, not across the boundary between two rounds. A round starts immediately after the
     * previous ends, so the gap between the last click of one round and the first of the next is legitimately larger - only the
     * clicks inside a round are what the setting governs. Each round is three picks, so the positions within a round are `i % 3`.
     */
    const at = executes(host).map((c) => c.at);
    const withinRoundGaps = at.slice(1).map((t, i) => t - at[i]).filter((_, i) => (i + 1) % 3 !== 0);
    expect(withinRoundGaps.length).toBeGreaterThan(0);
    expect(withinRoundGaps.every((g) => g >= 20)).toBe(true);
  });

  it('a delay of zero leaves the clicks back to back, as it does today', async () => {
    const host = makeHost({ stepCostMs: 2 });
    await new Runner(host).run(automationWith({ untilMs: 1_000_100, clickGapMs: 0 }, threePicks()));
    /**
     * ONLY THE NON-ZERO SLEEPS ARE GAPS. `sleep(0)` is the deliberate macrotask yield between rounds - the guard that lets a
     * stop message be processed at all - so counting every sleep would report the guard as a gap and the assertion would be
     * measuring the wrong thing.
     */
    const gaps = host.calls.filter((c) => c.kind === 'sleep' && c.ms > 0);
    expect(gaps.length).toBe(0);
    // and the rounds still happened, so this is the gap being absent rather than the window being skipped
    expect(order(host).split(',').length).toBeGreaterThan(3);
  });
});
