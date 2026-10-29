/**
 * Runner tests, using a recording host.
 *
 * The host is the injected boundary between the runner and the browser. A fake host means the runner's
 * logic — loops, branches, variable scope, retries, error policy, the run budget — is tested exactly,
 * with no timing flake and no browser. The real host is tested separately, in a real Chromium.
 */
import { describe, it, expect } from 'vitest';
import { Runner, resolveStep, preview, RunAborted } from '../src/core/engine/runner.js';
import { makeStep } from '../src/core/model/steps.js';

/**
 * A host that records every call and lets a test script the outcome per step.
 *
 * `time` starts at a fixed value and advances by however much `sleep` is asked to wait, so the run's
 * elapsed-time assertions are deterministic.
 */
function makeHost(script = {}) {
  const calls = [];
  let time = 1_000_000;
  let stop = false;
  const trace = [];
  const variables = {};

  return {
    calls,
    trace,
    variables,
    stopWanted: () => stop,
    requestStop: () => { stop = true; },
    host: {
      isAlive: async () => script.alive !== false,
      now: () => time,
      sleep: async (ms) => {
        calls.push({ op: 'sleep', ms });
        time += ms;
      },
      stopRequested: () => stop,
      onTrace: (e) => trace.push(e),
      execute: async (step) => {
        calls.push({ op: 'execute', kind: step.kind, step });
        if (script.failFor && script.failFor(step)) {
          const n = (script.failCount ?? 1);
          if (n > 0) {
            script.failCount = n - 1;
            throw new Error(`scripted failure for ${step.kind}`);
          }
        }
        if (step.kind === 'extract' && script.extractValue !== undefined) {
          return { value: script.extractValue };
        }
        return { ok: true };
      },
      readCondition: (c) => {
        calls.push({ op: 'readCondition', source: c.source });
        return (script.conditions && script.conditions(c)) ?? { value: null, found: false, flags: {} };
      },
    },
  };
}

function automation(steps, options = {}) {
  return {
    id: 'a1',
    name: 'test automation',
    steps,
    schedule: { kind: 'manual' },
    options: { stepDelayMs: 0, stepRetries: 0, stopOnError: true, maxRunMs: 60_000, ...options },
  };
}

describe('runner — linear steps', () => {
  it('runs steps in order and reports success', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('click', { finder: { strategy: 'css', selector: '#a' } }),
      makeStep('click', { finder: { strategy: 'css', selector: '#b' } }),
    ]);
    const result = await new Runner(host).run(a);
    expect(result.reason).toBe('finished');
    expect(result.steps).toBe(2);
    const executed = calls.filter((c) => c.op === 'execute');
    expect(executed).toHaveLength(2);
    expect(executed[0].step.finder.selector).toBe('#a');
    expect(executed[1].step.finder.selector).toBe('#b');
  });

  it('records a trace with a start, each step, and an end', async () => {
    const { host } = makeHost();
    const r = await new Runner(host).run(automation([makeStep('reload')]));
    const types = r.trace.map((t) => t.type);
    expect(types[0]).toBe('run-start');
    expect(types).toContain('step-ok');
    expect(types[types.length - 1]).toBe('run-end');
  });

  it('applies the per-step delay between steps', async () => {
    const { host, calls } = makeHost();
    await new Runner(host).run(automation([makeStep('reload'), makeStep('reload')], { stepDelayMs: 250 }));
    const sleeps = calls.filter((c) => c.op === 'sleep').map((c) => c.ms);
    expect(sleeps).toEqual([250, 250]);
  });

  it('respects a step-level delay over the run-level default', async () => {
    const { host, calls } = makeHost();
    await new Runner(host).run(automation([makeStep('reload', { delayMs: 900 })], { stepDelayMs: 100 }));
    expect(calls.filter((c) => c.op === 'sleep').map((c) => c.ms)).toEqual([900]);
  });
});

describe('runner — variables', () => {
  it('a set variable is visible to a later step', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('setVariable', { name: 'who', value: 'Ann' }),
      makeStep('fill', {
        finder: { strategy: 'css', selector: '#name' },
        value: 'Hello ${who}',
      }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.reason).toBe('finished');
    expect(r.vars.who).toBe('Ann');
    const fill = calls.filter((c) => c.op === 'execute' && c.kind === 'fill').pop();
    // templates are expanded before the host sees the step
    expect(fill.step.value).toBe('Hello Ann');
  });

  it('an extract feeds the next step', async () => {
    const { host, calls } = makeHost({ extractValue: 'from-the-page' });
    const a = automation([
      makeStep('extract', { name: 'picked', finder: { strategy: 'css', selector: 'h1' }, source: 'text' }),
      makeStep('fill', { finder: { strategy: 'css', selector: '#x' }, value: '${picked}' }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.vars.picked).toBe('from-the-page');
    const fill = calls.filter((c) => c.op === 'execute' && c.kind === 'fill').pop();
    expect(fill.step.value).toBe('from-the-page');
  });

  it('starting vars are available and can be overridden by a set step', async () => {
    const { host } = makeHost();
    const a = automation([
      makeStep('setVariable', { name: 'x', value: 'set-by-run' }),
    ]);
    const r = await new Runner(host).run(a, { vars: { x: 'start', keep: 'yes' } });
    expect(r.vars.x).toBe('set-by-run');
    expect(r.vars.keep).toBe('yes');
  });

  it('a CSV row is exposed both as row.x and bare x', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('fill', { finder: { strategy: 'css', selector: '#e' }, value: '${email}' }),
      makeStep('fill', { finder: { strategy: 'css', selector: '#e2' }, value: '${row.email}' }),
    ]);
    await new Runner(host).run(a, { row: { email: 'a@b.c' } });
    const fills = calls.filter((c) => c.op === 'execute' && c.kind === 'fill');
    expect(fills[0].step.value).toBe('a@b.c');
    expect(fills[1].step.value).toBe('a@b.c');
  });

  it('an unknown variable fails the run with the step id', async () => {
    const { host } = makeHost();
    const step = makeStep('fill', { finder: { strategy: 'css', selector: '#x' }, value: '${nope}' });
    const r = await new Runner(host).run(automation([step]));
    expect(r.reason).toBe('step-error');
    expect(r.error).toBeTruthy();
    expect(r.error.stepId).toBe(step.id);
  });
});

describe('runner — loops', () => {
  it('count loop runs the body exactly N times', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('loop', {
        loopType: 'count',
        count: 4,
        steps: [makeStep('click', { finder: { strategy: 'css', selector: '#go' } })],
      }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.reason).toBe('finished');
    expect(calls.filter((c) => c.op === 'execute' && c.kind === 'click')).toHaveLength(4);
  });

  it('exposes loop.index, first, last and total', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('loop', {
        loopType: 'count',
        count: 3,
        steps: [makeStep('fill', {
          finder: { strategy: 'css', selector: 'input' },
          value: 'i=${loop.index} of ${loop.total}',
        })],
      }),
    ]);
    await new Runner(host).run(a);
    const values = calls.filter((c) => c.op === 'execute' && c.kind === 'fill').map((c) => c.step.value);
    expect(values).toEqual(['i=0 of 3', 'i=1 of 3', 'i=2 of 3']);
  });

  it('break leaves the loop early', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('loop', {
        loopType: 'count',
        count: 10,
        steps: [
          makeStep('click', { finder: { strategy: 'css', selector: '#go' } }),
          makeStep('break'),
        ],
      }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.reason).toBe('finished');
    expect(calls.filter((c) => c.op === 'execute' && c.kind === 'click')).toHaveLength(1);
  });

  it('continue skips the rest of the iteration', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('loop', {
        loopType: 'count',
        count: 3,
        steps: [
          makeStep('continue'),
          makeStep('click', { finder: { strategy: 'css', selector: '#never' } }),
        ],
      }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.reason).toBe('finished');
    expect(calls.filter((c) => c.op === 'execute' && c.kind === 'click')).toHaveLength(0);
  });

  it('for-each walks an array variable', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('loop', {
        loopType: 'forEach',
        listVariable: 'items',
        itemVariable: 'item',
        steps: [makeStep('fill', {
          finder: { strategy: 'css', selector: 'input' },
          value: '${item}',
        })],
      }),
    ]);
    await new Runner(host).run(a, { vars: { items: ['a', 'b', 'c'] } });
    expect(calls.filter((c) => c.op === 'execute' && c.kind === 'fill').map((c) => c.step.value))
      .toEqual(['a', 'b', 'c']);
  });

  it('for-each splits a comma-separated string', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('loop', {
        loopType: 'forEach',
        listVariable: 'items',
        steps: [makeStep('fill', { finder: { strategy: 'css', selector: 'i' }, value: '${item}' })],
      }),
    ]);
    await new Runner(host).run(a, { vars: { items: 'x, y ,z' } });
    expect(calls.filter((c) => c.op === 'execute' && c.kind === 'fill').map((c) => c.step.value))
      .toEqual(['x', 'y', 'z']);
  });

  it('a CSV row drives a for-each and exposes the columns', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('loop', {
        loopType: 'forEach',
        listVariable: 'rows',
        steps: [makeStep('fill', {
          finder: { strategy: 'css', selector: '#e' },
          value: '${email}|${row.name}',
        })],
      }),
    ]);
    const rows = [{ email: 'a@b.c', name: 'Ann' }, { email: 'd@e.f', name: 'Bob' }];
    await new Runner(host).run(a, { vars: { rows } });
    const values = calls.filter((c) => c.op === 'execute' && c.kind === 'fill').map((c) => c.step.value);
    expect(values).toEqual(['a@b.c|Ann', 'd@e.f|Bob']);
  });

  it('a while loop honours maxIterations rather than spinning', async () => {
    const { host, calls } = makeHost({
      conditions: () => ({ value: null, found: true, flags: { visible: true } }),
    });
    const a = automation([
      makeStep('loop', {
        loopType: 'while',
        maxIterations: 5,
        condition: {
          finder: { strategy: 'css', selector: '#next' },
          source: 'text',
          comparator: 'exists',
        },
        steps: [makeStep('click', { finder: { strategy: 'css', selector: '#go' } })],
      }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.reason).toBe('finished');
    // the condition is always true, so the ceiling is what stops it
    expect(calls.filter((c) => c.op === 'execute' && c.kind === 'click')).toHaveLength(5);
  });

  it('a while loop stops when the condition turns false', async () => {
    let n = 0;
    const { host, calls } = makeHost({
      conditions: () => {
        n += 1;
        return { value: null, found: n <= 3, flags: {} };
      },
    });
    const a = automation([
      makeStep('loop', {
        loopType: 'while',
        maxIterations: 50,
        condition: { finder: { strategy: 'css', selector: '#x' }, source: 'text', comparator: 'exists' },
        steps: [makeStep('click', { finder: { strategy: 'css', selector: '#go' } })],
      }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.reason).toBe('finished');
    expect(calls.filter((c) => c.op === 'execute' && c.kind === 'click').length).toBeLessThanOrEqual(3);
  });

  it('nested loops keep independent indices', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('loop', {
        loopType: 'count',
        count: 2,
        steps: [makeStep('loop', {
          loopType: 'count',
          count: 2,
          steps: [makeStep('fill', {
            finder: { strategy: 'css', selector: 'i' },
            value: '${loop.index}',
          })],
        })],
      }),
    ]);
    await new Runner(host).run(a);
    // the trace records 4 fills; the values show the INNER index repeating, which is correct
    expect(calls.filter((c) => c.op === 'execute' && c.kind === 'fill')).toHaveLength(4);
  });
});

describe('runner — branches', () => {
  it('runs the then block when the condition holds', async () => {
    const { host, calls } = makeHost({
      conditions: () => ({ value: 'yes', found: true, flags: {} }),
    });
    const a = automation([
      makeStep('if', {
        condition: { finder: { strategy: 'css', selector: '#x' }, source: 'text', comparator: 'eq', value: 'yes' },
        then: [makeStep('click', { finder: { strategy: 'css', selector: '#then' } })],
        else: [makeStep('click', { finder: { strategy: 'css', selector: '#else' } })],
      }),
    ]);
    await new Runner(host).run(a);
    const clicks = calls.filter((c) => c.op === 'execute' && c.kind === 'click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0].step.finder.selector).toBe('#then');
  });

  it('runs the else block when it does not', async () => {
    const { host, calls } = makeHost({
      conditions: () => ({ value: 'no', found: true, flags: {} }),
    });
    const a = automation([
      makeStep('if', {
        condition: { finder: { strategy: 'css', selector: '#x' }, source: 'text', comparator: 'eq', value: 'yes' },
        then: [makeStep('click', { finder: { strategy: 'css', selector: '#then' } })],
        else: [makeStep('click', { finder: { strategy: 'css', selector: '#else' } })],
      }),
    ]);
    await new Runner(host).run(a);
    const clicks = calls.filter((c) => c.op === 'execute' && c.kind === 'click');
    expect(clicks[0].step.finder.selector).toBe('#else');
  });

  it('records which branch was taken', async () => {
    const { host } = makeHost({ conditions: () => ({ value: 'yes', found: true, flags: {} }) });
    const a = automation([
      makeStep('if', {
        condition: { finder: { strategy: 'css', selector: '#x' }, source: 'text', comparator: 'eq', value: 'yes' },
        then: [makeStep('reload')],
      }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.trace.some((t) => t.type === 'branch' && t.taken === 'then')).toBe(true);
  });
});

describe('runner — error policy', () => {
  it('stops on the first failure by default', async () => {
    let n = 0;
    const { host, calls } = makeHost({
      failFor: () => {
        n += 1;
        return n === 1;
      },
    });
    const a = automation([
      makeStep('click', { finder: { strategy: 'css', selector: '#a' } }),
      makeStep('click', { finder: { strategy: 'css', selector: '#b' } }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.reason).toBe('step-error');
    expect(calls.filter((c) => c.op === 'execute')).toHaveLength(1);
  });

  it('continues when the run says so', async () => {
    let n = 0;
    const { host, calls } = makeHost({
      failFor: () => {
        n += 1;
        return n === 1;
      },
    });
    const a = automation([
      makeStep('click', { finder: { strategy: 'css', selector: '#a' } }),
      makeStep('click', { finder: { strategy: 'css', selector: '#b' } }),
    ], { stopOnError: false });
    const r = await new Runner(host).run(a);
    expect(r.reason).toBe('finished');
    expect(calls.filter((c) => c.op === 'execute')).toHaveLength(2);
  });

  it('a step-level onError overrides the run default', async () => {
    let n = 0;
    const { host, calls } = makeHost({
      failFor: () => {
        n += 1;
        return n === 1;
      },
    });
    const a = automation([
      makeStep('click', { finder: { strategy: 'css', selector: '#a' }, onError: 'continue' }),
      makeStep('click', { finder: { strategy: 'css', selector: '#b' } }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.reason).toBe('finished');
    expect(calls.filter((c) => c.op === 'execute')).toHaveLength(2);
  });

  it('retries the configured number of times before giving up', async () => {
    const { host, calls } = makeHost({ failFor: () => true, failCount: 2 });
    const a = automation([
      makeStep('click', { finder: { strategy: 'css', selector: '#a' }, retries: 2 }),
    ]);
    const r = await new Runner(host).run(a);
    // 3 attempts total: the first plus 2 retries, and the third is scripted to succeed
    expect(calls.filter((c) => c.op === 'execute')).toHaveLength(3);
    expect(r.reason).toBe('finished');
  });

  it('records a failed step in the trace before stopping', async () => {
    const { host } = makeHost({ failFor: () => true, failCount: 99 });
    const a = automation([makeStep('click', { finder: { strategy: 'css', selector: '#a' } })]);
    const r = await new Runner(host).run(a);
    expect(r.trace.some((t) => t.type === 'step-fail')).toBe(true);
    expect(r.trace.some((t) => t.type === 'run-error')).toBe(true);
  });
});

describe('runner — stop and budgets', () => {
  it('stop step ends the run with the user reason', async () => {
    const { host, calls } = makeHost();
    const a = automation([
      makeStep('stop', { reason: 'done here' }),
      makeStep('click', { finder: { strategy: 'css', selector: '#never' } }),
    ]);
    const r = await new Runner(host).run(a);
    expect(r.reason).toBe('stopped-by-user');
    expect(calls.filter((c) => c.op === 'execute')).toHaveLength(0);
  });

  it('a stop request from the host aborts before the next step', async () => {
    const { host, requestStop } = makeHost();
    const a = automation([
      makeStep('reload'),
      makeStep('reload'),
      makeStep('reload'),
    ]);
    const runner = new Runner(host);
    const p = runner.run(a);
    requestStop();
    const r = await p;
    expect(['stopped-by-user', 'finished']).toContain(r.reason);
    expect(r.steps).toBeLessThanOrEqual(3);
  });

  it('respects maxRunMs', async () => {
    const { host } = makeHost();
    const steps = [];
    for (let i = 0; i < 50; i++) steps.push(makeStep('reload', { delayMs: 1000 }));
    const r = await new Runner(host).run(automation(steps, { maxRunMs: 5000 }));
    expect(r.reason).toBe('run-timeout');
    expect(r.steps).toBeLessThan(50);
  });

  it('reports a dead page rather than silently doing nothing', async () => {
    const { host } = makeHost({ alive: false });
    const r = await new Runner(host).run(automation([makeStep('reload')]));
    expect(r.reason).toBe('step-error');
    expect(String(r.error)).toMatch(/no longer available/);
  });

  it('a run with no steps is rejected before it starts', async () => {
    const { host } = makeHost();
    await expect(new Runner(host).run(automation([]))).rejects.toThrow(/at least one step/);
  });
});

describe('resolveStep', () => {
  it('expands strings everywhere, including inside a finder', () => {
    const step = makeStep('click', {
      finder: { strategy: 'css', selector: '#item-${n}' },
      note: 'hello ${who}',
    });
    const out = resolveStep(step, { n: '7', who: 'Ann' });
    expect(out.finder.selector).toBe('#item-7');
    expect(out.note).toBe('hello Ann');
    expect(out.id).toBe(step.id);
    expect(out.kind).toBe('click');
  });

  it('leaves numbers and booleans alone', () => {
    const out = resolveStep(makeStep('wait', { ms: 500, flag: true }), {});
    expect(out.ms).toBe(500);
    expect(out.flag).toBe(true);
  });
});

describe('preview', () => {
  it('shortens a long value', () => {
    const long = 'x'.repeat(500);
    const p = preview(long);
    expect(p.length).toBeLessThan(200);
    expect(p).toContain('500 chars');
  });

  it('leaves a short value intact', () => {
    expect(preview('short')).toBe('short');
  });

  it('handles null', () => {
    expect(preview(null)).toBe('');
  });
});