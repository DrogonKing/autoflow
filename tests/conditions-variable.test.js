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
  it('reads a variable from vars rather than asking the page', () => {
    const vars = { status: 'ready' };
    const ok = evaluateCondition(
      { source: 'variable', variable: 'status', comparator: 'eq', value: 'ready' },
      { vars, read: pageHost().readCondition },
    );
    expect(ok).toBe(true);
  });

  it('matches the variable it names, not a different one', () => {
    const vars = { a: 'one', b: 'two' };
    expect(evaluateCondition(
      { source: 'variable', variable: 'a', comparator: 'eq', value: 'one' },
      { vars, read: pageHost().readCondition },
    )).toBe(true);
    expect(evaluateCondition(
      { source: 'variable', variable: 'b', comparator: 'eq', value: 'one' },
      { vars, read: pageHost().readCondition },
    )).toBe(false);
  });

  it('supports a numeric comparison on a variable', () => {
    const vars = { n: '42' };
    expect(evaluateCondition(
      { source: 'variable', variable: 'n', comparator: 'gt', value: '10' },
      { vars, read: pageHost().readCondition },
    )).toBe(true);
  });

  it('treats a missing variable as not matching rather than throwing', () => {
    expect(() => evaluateCondition(
      { source: 'variable', variable: 'nope', comparator: 'eq', value: 'x' },
      { vars: {}, read: pageHost().readCondition },
    )).not.toThrow();
    expect(evaluateCondition(
      { source: 'variable', variable: 'nope', comparator: 'eq', value: 'x' },
      { vars: {}, read: pageHost().readCondition },
    )).toBe(false);
  });

  it('the expected value is itself templated from vars', () => {
    // A condition like `variable status eq ${wanted}` is the useful shape for a data-driven run.
    const vars = { status: 'ready', wanted: 'ready' };
    expect(evaluateCondition(
      { source: 'variable', variable: 'status', comparator: 'eq', value: '${wanted}' },
      { vars, read: pageHost().readCondition },
    )).toBe(true);
  });
});

describe('a js condition source', () => {
  it('does NOT execute code - it is inert data', () => {
    // `steps.js` validates that `c.js` is present when source is 'js', so a user CAN author one. Nothing
    // evaluates it: conditions.js routes it through ctx.read, and the page returns null for it. This test
    // pins that behaviour so it is a decision rather than an accident.
    let executed = false;
    const evil = 'executed = true; return "pwned"';
    const vars = {};
    const result = evaluateCondition(
      { source: 'js', js: evil, comparator: 'eq', value: 'pwned' },
      {
        vars,
        read: (c) => {
          if (c.source === 'js') return { value: null, found: false, flags: {} };
          return { value: null, found: false, flags: {} };
        },
      },
    );
    expect(executed).toBe(false);
    expect(result).toBe(false);
  });
});
