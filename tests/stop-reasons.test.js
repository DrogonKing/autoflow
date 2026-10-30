/**
 * B10 and B11: stop reasons, and the three messenger faults.
 *
 * B10, MEASURED: a `stop` step and a `break` outside any loop both reported `stopped-by-user`, so the history blamed the
 * user for something the automation did - and a stray `break` is a bug in the automation that the report hid.
 *
 * B11, MEASURED:
 *   - `element-pick-cancelled` was in the content-script allowlist with no case in the worker, so the panel never heard
 *     that a pick was cancelled and its button stayed in "picking" forever;
 *   - `waitFor` demanded a finder for EVERY condition source, so "wait until the URL contains X" could not be saved;
 *   - an extract's finder never resolved `${var}`, because `__resolve` was passed as a FUNCTION - and functions do not
 *     survive the message port.
 */
import { describe, expect, it } from 'vitest';
import { Runner, STOP_REASONS } from '../src/core/engine/runner.js';
import { validateStep } from '../src/core/model/steps.js';

/** A host that records what it was asked to do. */
function makeHost() {
  const calls = [];
  let stop = false;
  return {
    calls,
    requestStop: () => { stop = true; },
    host: {
      async readCondition() { return ''; },
      async execute(step) { calls.push({ op: 'execute', step }); return { ok: true, value: 'extracted' }; },
      isAlive() { return true; },
      now() { return Date.now(); },
      onTrace() {},
      async sleep() {},
      stopRequested() { return stop; },
    },
  };
}

const automation = (steps) => ({ id: 'a', name: 't', enabled: true, schedule: { kind: 'manual' }, steps });
const step = (kind, over = {}) => ({ id: `s-${kind}-${Math.random().toString(36).slice(2, 6)}`, kind, ...over });

describe('B10: the stop reason says WHO ended the run', () => {
  it('a stop STEP reports stopped-by-step, not stopped-by-user', async () => {
    const { host, calls } = makeHost();
    const r = await new Runner(host).run(automation([step('stop'), step('click', { finder: { strategy: 'css', selector: '#x' } })]));
    expect(r.reason).toBe(STOP_REASONS.stoppedByStep);
    expect(calls.filter((c) => c.op === 'execute')).toHaveLength(0);
  });

  it('a BREAK outside any loop reports stray-break - it is a bug in the automation, not a decision', async () => {
    const { host } = makeHost();
    const r = await new Runner(host).run(automation([step('break')]));
    expect(r.reason).toBe(STOP_REASONS.strayBreak);
  });

  it('a real user stop still reports stopped-by-user', async () => {
    const { host, requestStop } = makeHost();
    requestStop();
    const r = await new Runner(host).run(automation([step('reload'), step('reload')]));
    expect(r.reason).toBe(STOP_REASONS.stopped);
  });

  it('a normal run reports finished', async () => {
    const { host } = makeHost();
    const r = await new Runner(host).run(automation([step('reload')]));
    expect(r.reason).toBe(STOP_REASONS.finished);
  });

  it('and the four reasons are all different - which is the point', () => {
    const set = new Set([
      STOP_REASONS.finished, STOP_REASONS.stopped,
      STOP_REASONS.stoppedByStep, STOP_REASONS.strayBreak,
    ]);
    expect(set.size, 'two reasons collapsed into one string').toBe(4);
  });
});

describe('B11: waitFor needs a finder only when it waits for an ELEMENT', () => {
  it('a URL wait can be saved without a finder', () => {
    expect(() => validateStep(step('waitFor', {
      condition: { source: 'url', comparator: 'contains', value: '/order' },
    }))).not.toThrow();
  });

  it('a title wait can too', () => {
    expect(() => validateStep(step('waitFor', {
      condition: { source: 'title', comparator: 'contains', value: 'confirm' },
    }))).not.toThrow();
  });

  it('but a TEXT wait still requires the element it reads', () => {
    expect(() => validateStep(step('waitFor', {
      condition: { source: 'text', comparator: 'visible' },
    }))).toThrow();
  });

  it('and click still requires a finder', () => {
    expect(() => validateStep(step('click', {}))).toThrow();
  });
});

describe('B11: an extract resolves ${var} in its finder BEFORE sending', () => {
  it('the finder the host receives has the value substituted', async () => {
    const { host, calls } = makeHost();
    const auto = automation([
      step('extract', {
        name: 'price',
        finder: { strategy: 'css', selector: '#price-${symbol}' },
      }),
    ]);
    auto.vars = { initial: { symbol: 'فزر' } };
    await new Runner(host).run(auto, { vars: { symbol: 'فزر' } });

    const sent = calls.find((c) => c.op === 'execute')?.step;
    expect(sent, 'nothing was sent').toBeTruthy();
    /**
     * The finder must contain the substituted value. This used to pass `__resolve` as a function instead, which the
     * receiver never gets, so the selector arrived containing the literal `${symbol}` and the wrong element was read.
     */
    expect(sent.finder.selector, 'the ${var} was not resolved').toContain('فزر');
    expect(sent.finder.selector).not.toContain('${');
    expect(sent.__resolve, 'a function was sent over the message port - it cannot arrive').toBeUndefined();
  });
});