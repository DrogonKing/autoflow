/**
 * Conditions whose source is the PAGE were always false.
 *
 * Reported by an outside review, and it is the most serious finding in it: `host.readCondition` is `async`, so it
 * returns a Promise. The runner passes it straight through as `ctx.read`, and `evaluateCondition` read
 * `observed.value` off that Promise - which is `undefined`. Every comparison was therefore against undefined, and
 * `exists` was false too because `obs.found` was undefined. So `if`, `while` and `waitFor` on anything from the page
 * silently took the false branch, forever.
 *
 * These tests call the real function the way the runner calls it, so the failure is reproduced rather than described.
 */
import { describe, expect, it } from 'vitest';
import { evaluateCondition } from '../src/core/engine/conditions.js';

/** What the runner builds today: `read` returns whatever the host returns, which for a page read is a Promise. */
const asyncCtx = (observation) => ({
  read: async () => observation,
  vars: {},
});

/** What it must become: an awaited read. */
const awaited = (observation) => ({
  read: async () => observation,
  vars: {},
});

describe('a page-sourced condition is evaluated against the observed value', () => {
  it('text eq matches when the page text matches', async () => {
    const ctx = asyncCtx({ value: 'ارسال شد', found: true, flags: {} });
    const result = await evaluateCondition(
      { source: 'text', finder: { strategy: 'css', selector: '#x' }, comparator: 'eq', value: 'ارسال شد' },
      ctx,
    );
    expect(result).toBe(true);
  });

  it('the same condition does NOT match a different value', async () => {
    const ctx = awaited({ value: 'در انتظار', found: true, flags: {} });
    const result = await evaluateCondition(
      { source: 'text', finder: { strategy: 'css', selector: '#x' }, comparator: 'eq', value: 'ارسال شد' },
      ctx,
    );
    expect(result).toBe(false);
  });

  it('exists is true when the element was found', async () => {
    const ctx = awaited({ value: 'x', found: true, flags: {} });
    expect(await evaluateCondition(
      { source: 'text', finder: { strategy: 'css', selector: '#x' }, comparator: 'exists' }, ctx,
    )).toBe(true);
  });

  it('exists is false when the element was not found', async () => {
    const ctx = awaited({ value: null, found: false, flags: {} });
    expect(await evaluateCondition(
      { source: 'text', finder: { strategy: 'css', selector: '#x' }, comparator: 'exists' }, ctx,
    )).toBe(false);
  });

  it('visible reads the flag', async () => {
    const ctx = awaited({ value: 'x', found: true, flags: { visible: true, hidden: false } });
    expect(await evaluateCondition(
      { source: 'text', finder: { strategy: 'css', selector: '#x' }, comparator: 'visible' }, ctx,
    )).toBe(true);
  });

  it('url eq matches', async () => {
    const ctx = awaited({ value: 'https://example.test/order', found: true, flags: {} });
    expect(await evaluateCondition(
      { source: 'url', comparator: 'contains', value: '/order' }, ctx,
    )).toBe(true);
  });

  it('countGt compares the count', async () => {
    const ctx = awaited({ value: '', found: true, flags: {}, count: 5 });
    expect(await evaluateCondition(
      { source: 'text', finder: { strategy: 'css', selector: '#x' }, comparator: 'countGt', value: 3 }, ctx,
    )).toBe(true);
  });

  it('a nested `also` is awaited too, not compared as a Promise', async () => {
    const ctx = awaited({ value: 'x', found: true, flags: { visible: true } });
    const result = await evaluateCondition({
      source: 'text', finder: { strategy: 'css', selector: '#x' }, comparator: 'exists',
      also: [{ source: 'text', finder: { strategy: 'css', selector: '#y' }, comparator: 'visible' }],
      combine: 'all',
    }, ctx);
    expect(result).toBe(true);
  });

  it('a variable source stays synchronous-friendly and correct', async () => {
    const ctx = { read: async () => ({ value: null, found: false, flags: {} }), vars: { status: 'ready' } };
    expect(await evaluateCondition(
      { source: 'variable', variable: 'status', comparator: 'eq', value: 'ready' }, ctx,
    )).toBe(true);
  });
});

describe('the bug itself, kept as a test so it cannot come back', () => {
  it('a PROMISE from read must not be compared as if it were an observation', async () => {
    /**
     * This is the shape the runner produced before the fix: `read` returns the host's async function directly, so
     * what arrives is a Promise. Evaluating it must not silently yield false for a condition that IS true - the
     * function has to await it.
     */
    const ctx = {
      read: () => Promise.resolve({ value: 'ارسال شد', found: true, flags: { visible: true } }),
      vars: {},
    };
    const result = await evaluateCondition(
      { source: 'text', finder: { strategy: 'css', selector: '#x' }, comparator: 'eq', value: 'ارسال شد' }, ctx,
    );
    expect(result).toBe(true);
  });
});