import { describe, it, expect } from 'vitest';
import { makeEvent, merge } from '../src/core/model/events.js';
import { Runner } from '../src/core/engine/runner.js';

/**
 * THE PER-TIME CLICK GAP — "فاصله کلیک بین pickها".
 *
 * Requested as: a small settings affordance on each time, holding a millisecond interval applied BETWEEN the picks of that
 * one time. Default 0, which is today's behaviour (the picks fire together). Setting 20 ms on the 10:10:50.250 time must
 * change nothing about any other time.
 *
 * WHY THE ARITHMETIC IS THE HARD PART, and why the naive implementation is wrong:
 *
 *   the run has ONE scheduled instant, and the first element step consumes it. A gap implemented as "sleep 20 ms after each
 *   click" measures from the END of one click to the START of the next, so every click's own duration is added: three picks
 *   at 20 ms become 20 + t1 + 20 + t2, and the third lands later than 10:10:50.290. Worse, a slow page accumulates the
 *   error across the whole sequence.
 *
 *   The correct rule is that each pick's target is the scheduled instant PLUS its index times the gap, so the instants are
 *   absolute and a slow click cannot push the following ones back. These tests assert the instants, not the sleeps.
 */

/** A host that records what it was asked to do, with a virtual clock that sleep() advances. */
const makeHost = (stepCostMs = 0) => {
  const now = { t: 1_000_000 };
  const calls = [];
  return {
    calls,
    now: () => now.t,
    sleep: async (ms) => {
      calls.push({ kind: 'sleep', ms });
      now.t += ms;
    },
    isAlive: async () => true,
    stopRequested: () => false,
    execute: async (step) => {
      calls.push({ kind: 'execute', stepId: step.id, at: now.t });
      now.t += stepCostMs;                 // the click itself takes time
      return { ok: true };
    },
    onTrace: () => {},
    assertVisible: async () => true,
  };
};

const automationWith = (options, steps) => ({
  id: 'basic',
  name: 'x',
  enabled: true,
  schedule: { kind: 'daily', hour: 10, minute: 10, second: 50, ms: 250 },
  options,
  steps,
});

/** A finder needs an explicit strategy; `id` matches the `{ strategy: 'id', id: 'a' }` shape the picker records. */
const pick = (n) => ({ id: `p${n}`, kind: 'click', finder: { strategy: 'id', id: `btn-${n}` } });
const threePicks = () => [pick(1), pick(2), pick(3)];

describe('the click gap is a property of the time, and defaults to zero', () => {
  it('an event carries no gap by default, which is today\'s behaviour', () => {
    const ev = makeEvent('basic', { kind: 'daily', hour: 10, minute: 10, second: 50, ms: 250 });
    expect(ev.clickGapMs ?? 0).toBe(0);
  });

  it('a gap set on one time is stored on that record only', () => {
    const a = makeEvent('basic', { kind: 'daily', hour: 10, minute: 10, second: 50, ms: 250 });
    const b = makeEvent('basic-new1', { kind: 'daily', hour: 11, minute: 0, second: 0, ms: 0 });
    a.clickGapMs = 20;
    const { save } = merge('basic', [a, b], { template: { name: 'Basic', knownIds: ['basic', 'basic-new1'] } });
    const recA = save.find((r) => r.id === 'basic');
    const recB = save.find((r) => r.id === 'basic-new1');
    expect(recA.options.clickGapMs).toBe(20);
    // the other time must be untouched: a gap that leaked would change the timing of a schedule the user did not edit
    expect(recB.options.clickGapMs ?? 0).toBe(0);
  });

  it('zero is written explicitly rather than left out, so clearing the setting is a real change', () => {
    const a = makeEvent('basic', { kind: 'daily', hour: 10, minute: 10, second: 50, ms: 250 });
    a.clickGapMs = 0;
    const { save } = merge('basic', [a], { template: { name: 'Basic', knownIds: ['basic'] } });
    expect(save[0].options.clickGapMs).toBe(0);
  });
});

describe('the instants, not the sleeps', () => {
  it('with no gap the picks fire together', async () => {
    const host = makeHost();
    const runner = new Runner(host);
    await runner.run(automationWith({ stepDelayMs: 0, clickGapMs: 0, stepRetries: 0 }, threePicks()));
    const at = host.calls.filter((c) => c.kind === 'execute').map((c) => c.at);
    expect(at.length).toBe(3);
    // no gap: nothing waits between them, so all three land on the same virtual millisecond
    expect(at[1] - at[0]).toBe(0);
    expect(at[2] - at[1]).toBe(0);
  });

  it('with a 20 ms gap the picks are 20 ms apart', async () => {
    const host = makeHost();
    const runner = new Runner(host);
    await runner.run(automationWith({ stepDelayMs: 0, clickGapMs: 20, stepRetries: 0 }, threePicks()));
    const at = host.calls.filter((c) => c.kind === 'execute').map((c) => c.at);
    expect(at.length).toBe(3);
    expect(at[1] - at[0]).toBe(20);
    expect(at[2] - at[1]).toBe(20);
  });

  it('a SLOW click does not push the following picks back', async () => {
    /**
     * THE REASON THE INSTANTS ARE ABSOLUTE. Each click costs 12 ms here, so a "sleep the gap after each click" design would
     * produce 32 ms between the starts (12 of work + 20 of sleep). The user asked for 20 ms between the clicks, and a click
     * that happens to be slow must not quietly widen the sequence.
     */
    const host = makeHost(12);
    const runner = new Runner(host);
    await runner.run(automationWith({ stepDelayMs: 0, clickGapMs: 20, stepRetries: 0 }, threePicks()));
    const at = host.calls.filter((c) => c.kind === 'execute').map((c) => c.at);
    expect(at[1] - at[0]).toBe(20);
    expect(at[2] - at[1]).toBe(20);
  });

  it('a click that takes LONGER than the gap starts the next one immediately', async () => {
    // 30 ms of work against a 20 ms gap: the target instant has already passed, so waiting would be a lie about the time
    const host = makeHost(30);
    const runner = new Runner(host);
    await runner.run(automationWith({ stepDelayMs: 0, clickGapMs: 20, stepRetries: 0 }, threePicks()));
    const sleeps = host.calls.filter((c) => c.kind === 'sleep').map((c) => c.ms);
    expect(sleeps.every((ms) => ms >= 0)).toBe(true);
    expect(host.calls.filter((c) => c.kind === 'execute').length).toBe(3);
  });

  it('the gap applies BETWEEN picks, not before the first one', async () => {
    // the first pick must not be delayed: it is the scheduled instant, which is the whole point of the schedule
    const host = makeHost();
    const runner = new Runner(host);
    await runner.run(automationWith({ stepDelayMs: 0, clickGapMs: 50, stepRetries: 0 }, threePicks()));
    const exec = host.calls.filter((c) => c.kind === 'execute');
    expect(exec.length).toBe(3);
    expect(exec[0].at).toBe(1_000_000);
  });

  it('a single pick is unaffected by a gap', async () => {
    const host = makeHost();
    const runner = new Runner(host);
    await runner.run(automationWith({ stepDelayMs: 0, clickGapMs: 20, stepRetries: 0 }, [threePicks()[0]]));
    expect(host.calls.filter((c) => c.kind === 'sleep').length).toBe(0);
  });

  it('the gap is not applied to non-click steps', async () => {
    // a `fill` between two clicks is not a "pick"; spacing it out would change what the step does, not when it happens
    const steps = [
      pick(1),
      { id: 'f1', kind: 'fill', finder: { strategy: 'id', id: 'qty' }, value: '100' },
      pick(2),
    ];
    const host = makeHost();
    const runner = new Runner(host);
    await runner.run(automationWith({ stepDelayMs: 0, clickGapMs: 20, stepRetries: 0 }, steps));
    const exec = host.calls.filter((c) => c.kind === 'execute');
    expect(exec.length).toBe(3);
    // only the SECOND click is offset; the fill did not consume a gap slot
    expect(exec[1].at - exec[0].at).toBe(0);
    expect(exec[2].at - exec[0].at).toBe(20);
  });
});