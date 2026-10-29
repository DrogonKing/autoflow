/**
 * Condition tests.
 *
 * The truth table is where the bugs live, so it is tested exhaustively: every comparator against a
 * found value, a missing element, the wrong type, and a case-sensitivity setting.
 */
import { describe, it, expect } from 'vitest';
import { compare, evaluateCondition, describeCondition, ConditionError } from '../src/core/engine/conditions.js';

describe('compare — string comparators', () => {
  it('eq and neq', () => {
    expect(compare('eq', 'abc', 'abc')).toBe(true);
    expect(compare('eq', 'abc', 'abd')).toBe(false);
    expect(compare('neq', 'abc', 'abd')).toBe(true);
  });

  it('is case-insensitive unless asked otherwise', () => {
    expect(compare('eq', 'ABC', 'abc')).toBe(true);
    expect(compare('eq', 'ABC', 'abc', { caseSensitive: true })).toBe(false);
    expect(compare('contains', 'Hello World', 'WORLD')).toBe(true);
    expect(compare('contains', 'Hello World', 'WORLD', { caseSensitive: true })).toBe(false);
  });

  it('contains and notContains', () => {
    expect(compare('contains', 'hello world', 'lo wo')).toBe(true);
    expect(compare('notContains', 'hello', 'xyz')).toBe(true);
  });

  it('startsWith and endsWith', () => {
    expect(compare('startsWith', 'https://x.com', 'https://')).toBe(true);
    expect(compare('endsWith', 'file.pdf', '.pdf')).toBe(true);
    expect(compare('endsWith', 'file.pdf', '.doc')).toBe(false);
  });

  it('matches uses a regular expression', () => {
    expect(compare('matches', 'order 12345', '^order \\d+$')).toBe(true);
    expect(compare('matches', 'nope', '^order \\d+$')).toBe(false);
  });

  it('reports an invalid regex instead of quietly returning false', () => {
    // A broken pattern is a user mistake worth reporting, not a condition that never matches.
    expect(() => compare('matches', 'x', '[')).toThrow(ConditionError);
    expect(() => compare('matches', 'x', '[')).toThrow(/invalid/);
  });
});

describe('compare — numeric comparators', () => {
  it('compares as numbers, not strings', () => {
    // The classic bug: "9" > "10" is true lexicographically.
    expect(compare('gt', '9', '10')).toBe(false);
    expect(compare('lt', '9', '10')).toBe(true);
  });

  it('gt, gte, lt, lte', () => {
    expect(compare('gt', '10', '9')).toBe(true);
    expect(compare('gte', '10', '10')).toBe(true);
    expect(compare('lt', '9', '10')).toBe(true);
    expect(compare('lte', '10', '10')).toBe(true);
  });

  it('handles decimals and negatives', () => {
    expect(compare('gt', '1.5', '1.4')).toBe(true);
    expect(compare('lt', '-5', '-4')).toBe(true);
  });

  it('refuses to compare non-numbers with a clear message', () => {
    expect(() => compare('gt', 'abc', '10')).toThrow(/can only compare numbers/);
    expect(() => compare('gt', '10', 'abc')).toThrow(/can only compare numbers/);
  });
});

describe('compare — existence comparators', () => {
  it('exists and notExists', () => {
    expect(compare('exists', 'anything')).toBe(true);
    expect(compare('exists', null)).toBe(false);
    expect(compare('exists', undefined)).toBe(false);
    expect(compare('notExists', null)).toBe(true);
    expect(compare('notExists', 'x')).toBe(false);
  });

  it('empty and notEmpty', () => {
    expect(compare('empty', '')).toBe(true);
    expect(compare('empty', '   ')).toBe(true);
    expect(compare('empty', null)).toBe(true);
    expect(compare('empty', 'x')).toBe(false);
    expect(compare('notEmpty', 'x')).toBe(true);
  });

  it('boolean flags come through as true only when the caller says so', () => {
    expect(compare('visible', true)).toBe(true);
    expect(compare('visible', false)).toBe(false);
    expect(compare('checked', true)).toBe(true);
  });
});

describe('compare — count comparators', () => {
  it('countEq, countGt, countLt', () => {
    expect(compare('countEq', 3, '3')).toBe(true);
    expect(compare('countGt', 3, '2')).toBe(true);
    expect(compare('countLt', 3, '4')).toBe(true);
  });

  it('rejects a non-numeric count', () => {
    expect(() => compare('countGt', 'many', '2')).toThrow(/compares counts/);
  });
});

describe('compare — unknown comparator', () => {
  it('throws rather than returning undefined', () => {
    expect(() => compare('sortof', 'a', 'b')).toThrow(/unknown comparator/);
  });
});

describe('evaluateCondition', () => {
  const read = (obs) => () => obs;

  it('compares element text', () => {
    const c = {
      finder: { strategy: 'css', selector: '#x' },
      source: 'text', comparator: 'eq', value: 'Ready',
    };
    expect(evaluateCondition(c, { read: read({ value: 'Ready', found: true, flags: {} }) })).toBe(true);
    expect(evaluateCondition(c, { read: read({ value: 'Busy', found: true, flags: {} }) })).toBe(false);
  });

  it('a missing element makes a value comparison false, not an error', () => {
    // waitFor depends on this: "not there yet" must be a normal false.
    const c = {
      finder: { strategy: 'css', selector: '#x' },
      source: 'text', comparator: 'eq', value: 'Ready',
    };
    expect(evaluateCondition(c, { read: read({ value: null, found: false, flags: {} }) })).toBe(false);
  });

  it('exists works on a missing element', () => {
    const c = { finder: { strategy: 'css', selector: '#x' }, source: 'text', comparator: 'exists' };
    expect(evaluateCondition(c, { read: read({ found: true, value: 'x', flags: {} }) })).toBe(true);
    expect(evaluateCondition(c, { read: read({ found: false, value: null, flags: {} }) })).toBe(false);
  });

  it('flags drive the visibility comparators', () => {
    const c = { finder: { strategy: 'css', selector: '#x' }, source: 'text', comparator: 'visible' };
    expect(evaluateCondition(c, { read: read({ found: true, value: '', flags: { visible: true } }) })).toBe(true);
    expect(evaluateCondition(c, { read: read({ found: true, value: '', flags: { visible: false } }) })).toBe(false);
  });

  it('counts matches', () => {
    const c = { finder: { strategy: 'css', selector: '.row' }, source: 'count', comparator: 'countGt', value: '2' };
    expect(evaluateCondition(c, { read: read({ count: 5, found: true, flags: {} }) })).toBe(true);
    expect(evaluateCondition(c, { read: read({ count: 1, found: true, flags: {} }) })).toBe(false);
  });

  it('compares the page url without needing a finder', () => {
    const c = { source: 'url', comparator: 'contains', value: '/dashboard' };
    expect(evaluateCondition(c, { read: read({ value: 'https://a.com/dashboard?x=1' }) })).toBe(true);
  });

  it('compares a variable, reading it from vars and NOT from the page', () => {
    // This test previously asserted the opposite - that a variable condition reads through `read`, i.e. from
    // the page - and it passed because the stub returned a value. The real page returns `{ value: null }` for
    // a variable, so the assertion encoded a bug: a variable condition could never match in the browser. The
    // `read` stub here deliberately returns something different, to prove it is not consulted.
    const c = { source: 'variable', variable: 'status', comparator: 'eq', value: 'ok' };
    expect(evaluateCondition(c, { read: read({ value: 'FROM-THE-PAGE' }), vars: { status: 'ok' } })).toBe(true);
    expect(evaluateCondition(c, { read: read({ value: 'ok' }), vars: { status: 'ok' } })).toBe(true);
    // and with no vars it does not match, rather than somehow picking up the page value
    expect(evaluateCondition(c, { read: read({ value: 'ok' }) })).toBe(false);
  });

  it('interpolates the expected value when vars are given', () => {
    const c = {
      finder: { strategy: 'css', selector: '#x' },
      source: 'text', comparator: 'eq', value: '${expected}',
    };
    expect(
      evaluateCondition(c, { read: read({ value: 'yes', found: true, flags: {} }), vars: { expected: 'yes' } }),
    ).toBe(true);
  });

  it('a template that cannot resolve falls back to a literal, not an abort', () => {
    const c = {
      finder: { strategy: 'css', selector: '#x' },
      source: 'text', comparator: 'eq', value: '${missing}',
    };
    // must not throw: a run should not die because one condition could not resolve
    expect(() =>
      evaluateCondition(c, { read: read({ value: 'x', found: true, flags: {} }), vars: {} }),
    ).not.toThrow();
  });
});

describe('evaluateCondition — combining', () => {
  const read = () => ({ value: 'yes', found: true, flags: {} });

  it('AND by default', () => {
    const c = {
      finder: { strategy: 'css', selector: '#a' }, source: 'text', comparator: 'eq', value: 'yes',
      combine: 'all',
      also: [{ finder: { strategy: 'css', selector: '#b' }, source: 'text', comparator: 'eq', value: 'yes' }],
    };
    expect(evaluateCondition(c, { read })).toBe(true);
  });

  it('AND fails when a sub-condition fails', () => {
    let i = 0;
    const c = {
      finder: { strategy: 'css', selector: '#a' }, source: 'text', comparator: 'eq', value: 'yes',
      also: [{ finder: { strategy: 'css', selector: '#b' }, source: 'text', comparator: 'eq', value: 'no' }],
    };
    const r = (obs) => () => obs;
    expect(evaluateCondition(c, { read: r({ value: 'yes', found: true, flags: {} }) })).toBe(false);
  });

  it('OR succeeds when any part holds', () => {
    const c = {
      finder: { strategy: 'css', selector: '#a' }, source: 'text', comparator: 'eq', value: 'no',
      combine: 'any',
      also: [{ finder: { strategy: 'css', selector: '#b' }, source: 'text', comparator: 'eq', value: 'yes' }],
    };
    expect(evaluateCondition(c, { read })).toBe(true);
  });

  it('validates the tree before evaluating, so a bad sub-condition is caught', () => {
    const c = {
      finder: { strategy: 'css', selector: '#a' }, source: 'text', comparator: 'eq', value: 'yes',
      also: [{ finder: { strategy: 'css', selector: '#b' }, source: 'text', comparator: 'nonsense' }],
    };
    expect(() => evaluateCondition(c, { read })).toThrow();
  });

  it('a numeric comparator inside a sub-condition is validated up front', () => {
    const c = {
      finder: { strategy: 'css', selector: '#a' }, source: 'text', comparator: 'eq', value: 'x',
      also: [{ finder: { strategy: 'css', selector: '#b' }, source: 'count', comparator: 'countGt', value: 'abc' }],
    };
    expect(() => evaluateCondition(c, { read })).toThrow(/compares counts|not one/);
  });
});

describe('describeCondition', () => {
  it('reads like a sentence', () => {
    expect(describeCondition({
      finder: { strategy: 'css', selector: '#submit' }, source: 'text', comparator: 'eq', value: 'Go',
    })).toMatch(/element #submit.*equals.*Go/i);

    expect(describeCondition({ source: 'url', comparator: 'contains', value: '/x' }))
      .toMatch(/page URL contains/);
    expect(describeCondition({ source: 'title', comparator: 'matches', value: 'x' }))
      .toMatch(/page title/);
    expect(describeCondition({ source: 'variable', variable: 'n', comparator: 'exists' }))
      .toMatch(/variable n exists/);
  });

  it('describes each finder strategy', () => {
    for (const f of [
      { strategy: 'css', selector: 'a' },
      { strategy: 'xpath', xpath: '//a' },
      { strategy: 'text', text: 'hi' },
      { strategy: 'id', id: 'x' },
      { strategy: 'name', name: 'q' },
      { strategy: 'label', label: 'L' },
      { strategy: 'placeholder', placeholder: 'p' },
      { strategy: 'aria', aria: 'A' },
      { strategy: 'role', role: 'button' },
      { strategy: 'point', x: 1, y: 2 },
    ]) {
      const s = describeCondition({ finder: f, source: 'text', comparator: 'exists' });
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(5);
    }
  });

  it('mentions the join for a combined condition', () => {
    const c = {
      finder: { strategy: 'css', selector: '#a' }, source: 'text', comparator: 'exists', combine: 'any',
      also: [{ finder: { strategy: 'css', selector: '#b' }, source: 'text', comparator: 'exists' }],
    };
    expect(describeCondition(c)).toMatch(/OR/);
  });

  it('says always for a missing condition', () => {
    expect(describeCondition(null)).toBe('always');
  });
});