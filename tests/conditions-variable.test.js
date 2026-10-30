/**
 * Does a `variable` condition actually read the variable?
 *
 * Found while auditing: `evaluateCondition` routes `variable` through `ctx.read(condition)`, and the runner's
 * `ctx.read` is `host.readCondition` - which asks the PAGE. The page's `observe()` short-circuits `variable`
 * (along with `url`, `title`, `js`) and returns `{ value: null }`. So if nothing resolves the variable before
 * that call, a variable condition can never match.
 *
 * This is a behavioural test, not a security one, but it is the finding that matters most from the audit: a
 * condition that silently never matches is worse than one that throws, because an automation that runs on the
 * wrong branch looks like it is working.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../src/core/engine/conditions.js';
import { validateCondition } from '../src/core/model/steps.js';

/** A host that behaves like the real one: the page cannot answer a variable. */
const pageHost = () => ({
  readCondition: (c) => {
    // exactly what the content script's observe() does for these sources
    if (['url', 'title', 'variable', 'js'].includes(c.source)) {
      return { value: null, found: false, flags: {} };
    }
    return { value: 'from the page', found: true, flags: {}, count: 1 };
  },
});

describe('variable conditions', () => {
  it('reads a variable from vars rather than asking the page', async () => {
    const vars = { status: 'ready' };
    const ok = await evaluateCondition(
      { source: 'variable', variable: 'status', comparator: 'eq', value: 'ready' },
      { vars, read: pageHost().readCondition },
    );
    expect(ok).toBe(true);
  });

  it('matches the variable it names, not a different one', async () => {
    const vars = { a: 'one', b: 'two' };
    expect(await evaluateCondition(
      { source: 'variable', variable: 'a', comparator: 'eq', value: 'one' },
      { vars, read: pageHost().readCondition },
    )).toBe(true);
    expect(await evaluateCondition(
      { source: 'variable', variable: 'b', comparator: 'eq', value: 'one' },
      { vars, read: pageHost().readCondition },
    )).toBe(false);
  });

  it('supports a numeric comparison on a variable', async () => {
    const vars = { n: '42' };
    expect(await evaluateCondition(
      { source: 'variable', variable: 'n', comparator: 'gt', value: '10' },
      { vars, read: pageHost().readCondition },
    )).toBe(true);
  });

  it('treats a missing variable as not matching rather than throwing', async () => {
    expect(() => evaluateCondition(
      { source: 'variable', variable: 'nope', comparator: 'eq', value: 'x' },
      { vars: {}, read: pageHost().readCondition },
    )).not.toThrow();
    expect(await evaluateCondition(
      { source: 'variable', variable: 'nope', comparator: 'eq', value: 'x' },
      { vars: {}, read: pageHost().readCondition },
    )).toBe(false);
  });

  it('the expected value is itself templated from vars', async () => {
    // A condition like `variable status eq ${wanted}` is the useful shape for a data-driven run.
    const vars = { status: 'ready', wanted: 'ready' };
    expect(await evaluateCondition(
      { source: 'variable', variable: 'status', comparator: 'eq', value: '${wanted}' },
      { vars, read: pageHost().readCondition },
    )).toBe(true);
  });
});

describe('a js condition source', () => {
  /**
   * THE PREVIOUS VERSION OF THIS TEST WAS THE HAZARD, WRITTEN DOWN.
   *
   * It asserted that a `source: 'js'` condition "does NOT execute code - it is inert data", on the grounds that nothing
   * evaluates it today. That is not a safety property, it is a description of the current code: a saved automation could
   * carry a script condition, and any future path that read it would execute it. The security scan flags the ACCEPTANCE of
   * that source as critical, and it is right - the door being open is the finding, whether or not anyone walked through it.
   *
   * The source is gone from the model now. A file written against the old shape is refused with a message that says what
   * to do instead.
   */
  it('is REFUSED by validation, so a file cannot carry one', async () => {
    let threw = null;
    try {
      validateCondition({ source: 'js', js: 'return 1', comparator: 'eq', value: '1' });
    } catch (e) { threw = e; }
    expect(threw, 'a js condition was accepted').toBeTruthy();
    // either message is correct - what matters is that it is REFUSED and says something useful
    expect(String(threw.message)).toMatch(/cannot run a script|unknown condition source/i);
  });

  it('and the model no longer lists it as a source', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/core/model/steps.js'), 'utf8');
    const list = /const sources = \[([^\]]+)\]/.exec(src)?.[1] ?? '';
    expect(list, 'js is still an accepted condition source').not.toMatch(/'js'/);
  });
});
