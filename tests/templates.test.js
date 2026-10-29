/**
 * Template and variable tests.
 *
 * The clock and the randomness are injected, so every assertion here is exact rather than "looks about
 * right". That matters because a templating bug shows up as "the wrong value was submitted", which is
 * impossible to debug from a screenshot.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  interpolate, evaluateExpression, templateNames, hasTemplate, normaliseVars,
  TemplateError, jitter,
} from '../src/core/model/templates.js';

const FIXED = new Date(2026, 2, 10, 14, 30, 45); // 10 March 2026, 14:30:45 local
const now = () => FIXED;

describe('variables', () => {
  it('substitutes a simple variable', () => {
    expect(interpolate('Hi ${name}', { name: 'Ann' })).toBe('Hi Ann');
  });

  it('substitutes several in one string', () => {
    expect(interpolate('${a}-${b}', { a: '1', b: '2' })).toBe('1-2');
  });

  it('leaves text without templates untouched, including a lone dollar sign', () => {
    expect(interpolate('cost is $5', {})).toBe('cost is $5');
    expect(interpolate('$ {not a template}', {})).toBe('$ {not a template}');
  });

  it('throws on an unknown variable, because an empty field is worse', () => {
    // A typo like ${emial} must not silently submit an empty email.
    expect(() => interpolate('${emial}', { email: 'a@b.c' })).toThrow(TemplateError);
    expect(() => interpolate('${emial}', { email: 'a@b.c' })).toThrow(/unknown variable/);
  });

  it('can be told not to throw', () => {
    expect(interpolate('${nope}', {}, { strict: false })).toBe('${nope}');
  });

  it('reads a nested value', () => {
    expect(interpolate('${row.email}', { row: { email: 'x@y.z' } })).toBe('x@y.z');
  });

  it('treats numbers and null sanely', () => {
    expect(interpolate('${n}', { n: 42 })).toBe('42');
    expect(interpolate('${z}', { z: null })).toBe('');
    expect(interpolate('${u}', { u: undefined })).toBe('');
  });

  it('normaliseVars stringifies everything', () => {
    expect(normaliseVars({ a: 1, b: null, c: true })).toEqual({ a: '1', b: '', c: 'true' });
  });
});

describe('modifiers', () => {
  it('upper, lower, trim', () => {
    expect(interpolate('${x|upper}', { x: 'ab' })).toBe('AB');
    expect(interpolate('${x|lower}', { x: 'AB' })).toBe('ab');
    expect(interpolate('${x|trim}', { x: '  a  ' })).toBe('a');
  });

  it('default applies only when the value is empty', () => {
    expect(interpolate('${x|default:none}', { x: '' })).toBe('none');
    expect(interpolate('${x|default:none}', { x: 'set' })).toBe('set');
  });

  it('chains modifiers', () => {
    expect(interpolate('${x|trim|upper}', { x: ' ab ' })).toBe('AB');
  });

  it('rejects an unknown modifier instead of ignoring it', () => {
    expect(() => interpolate('${x|nope}', { x: 'a' })).toThrow(/unknown modifier/);
  });
});

describe('now', () => {
  it('formats the current time in several ways', () => {
    expect(evaluateExpression('now.date', {}, { now })).toBe('2026-03-10');
    expect(evaluateExpression('now.time', {}, { now })).toBe('14:30:45');
    expect(evaluateExpression('now.datetime', {}, { now })).toBe('2026-03-10 14:30:45');
    expect(evaluateExpression('now.year', {}, { now })).toBe('2026');
    expect(evaluateExpression('now.month', {}, { now })).toBe('03');
    expect(evaluateExpression('now.day', {}, { now })).toBe('10');
    expect(evaluateExpression('now.weekday', {}, { now })).toBe('Tuesday');
  });

  it('now with no format is a datetime', () => {
    expect(evaluateExpression('now', {}, { now })).toBe('2026-03-10 14:30:45');
  });

  it('shifts forward and back', () => {
    expect(evaluateExpression('now+1d.date', {}, { now })).toBe('2026-03-11');
    expect(evaluateExpression('now-1d.date', {}, { now })).toBe('2026-03-09');
    expect(evaluateExpression('now+2h.time', {}, { now })).toBe('16:30:45');
    expect(evaluateExpression('now-30m.time', {}, { now })).toBe('14:00:45');
    expect(evaluateExpression('now+45s.time', {}, { now })).toBe('14:31:30');
  });

  it('timestamp formats', () => {
    expect(evaluateExpression('now.timestamp', {}, { now })).toBe(String(FIXED.getTime()));
    expect(evaluateExpression('now.epoch', {}, { now })).toBe(String(Math.floor(FIXED.getTime() / 1000)));
    expect(evaluateExpression('now.iso', {}, { now })).toContain('2026-03-10');
  });

  it('rejects an unknown format with the list of real ones', () => {
    expect(() => evaluateExpression('now.nope', {}, { now })).toThrow(/unknown date format/);
  });
});

describe('random', () => {
  it('random.int stays in range', () => {
    for (let i = 0; i < 300; i++) {
      const v = Number(evaluateExpression('random.int(5,7)', {}));
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(7);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('random.int rejects an inverted range', () => {
    expect(() => evaluateExpression('random.int(9,2)', {})).toThrow(/inverted/);
  });

  it('random.float respects decimals', () => {
    const v = evaluateExpression('random.float(0,1,3)', {});
    expect(v).toMatch(/^\d\.\d{3}$/);
  });

  it('random.string has the requested length', () => {
    expect(evaluateExpression('random.string(12)', {})).toHaveLength(12);
  });

  it('random.pick returns one of the choices', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(evaluateExpression('random.pick(a,b,c)', {}));
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });

  it('random.uuid looks like a uuid', () => {
    expect(evaluateExpression('random.uuid()', {})).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('random.email looks like an email', () => {
    expect(evaluateExpression('random.email()', {})).toMatch(/^[a-z0-9]+@example\.com$/);
  });

  it('rejects an unknown random function', () => {
    expect(() => evaluateExpression('random.nope()', {})).toThrow(/unknown random function/);
  });

  it('a random value can be combined into a longer string', () => {
    const out = interpolate('user_${random.string(6)}@test.com', {});
    expect(out).toMatch(/^user_[a-z0-9]{6}@test\.com$/);
  });
});

describe('introspection', () => {
  it('hasTemplate detects dynamic text', () => {
    expect(hasTemplate('${a}')).toBe(true);
    expect(hasTemplate('plain')).toBe(false);
    expect(hasTemplate('$5')).toBe(false);
    expect(hasTemplate(null)).toBe(false);
  });

  it('templateNames lists the real dependencies only', () => {
    const names = templateNames('${email} ${row.name} ${now.date} ${random.int(1,2)} ${x|upper}');
    expect([...names].sort()).toEqual(['email', 'row.name', 'x']);
  });

  it('templateNames on plain text is empty', () => {
    expect(templateNames('nothing here').size).toBe(0);
  });
});

describe('jitter', () => {
  it('returns the base when no jitter is asked for', () => {
    expect(jitter(1000, 0)).toBe(1000);
  });

  it('stays within the band', () => {
    for (let i = 0; i < 200; i++) {
      const v = jitter(1000, 200);
      expect(v).toBeGreaterThanOrEqual(800);
      expect(v).toBeLessThanOrEqual(1200);
    }
  });

  it('never goes negative', () => {
    for (let i = 0; i < 200; i++) {
      expect(jitter(50, 500)).toBeGreaterThanOrEqual(0);
    }
  });
});