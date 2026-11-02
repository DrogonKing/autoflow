import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A DECIMAL COMMA IS A DECIMAL COMMA, AND A THOUSANDS SEPARATOR IS A THOUSANDS SEPARATOR.
 *
 * `parseNum` stripped EVERY comma, so `12,50` became `1250` - a hundredfold error on a price. In a trading panel that is
 * the difference between a condition on 12.5 and one on 1250, and it fails silently: the comparison simply uses the wrong
 * number. The Persian decimal separator (U+066B) was not handled at all and became NaN.
 *
 * The rule asserted here: a comma is a THOUSANDS separator only when it groups exactly three digits, and otherwise it is
 * the decimal separator. That is the convention in every locale that writes decimals with a comma.
 *
 * The function is extracted from the source so the test cannot drift from the shipped implementation.
 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(path.join(ROOT, 'src/core/engine/conditions.js'), 'utf8');

function extractParseNum() {
  const start = SRC.indexOf('function parseNum(v) {');
  if (start < 0) throw new Error('parseNum not found in conditions.js');
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces after parseNum');
}

const parseNum = new Function(`${extractParseNum()}; return parseNum;`)();

describe('parseNum and the decimal comma', () => {
  it('reads a decimal comma as a decimal point', () => {
    expect(parseNum('12,50')).toBe(12.5);
    expect(parseNum('0,5')).toBe(0.5);
    expect(parseNum('100,25')).toBe(100.25);
  });

  it('still removes a genuine thousands separator', () => {
    expect(parseNum('1,234')).toBe(1234);
    expect(parseNum('1,234,567')).toBe(1234567);
    expect(parseNum('1,234,567.5')).toBe(1234567.5);
  });

  it('handles the two together', () => {
    expect(parseNum('1.234,56')).toBe(1234.56);
    expect(parseNum('1,234.56')).toBe(1234.56);
  });

  it('handles the Persian decimal separator (U+066B)', () => {
    expect(parseNum('12٫50')).toBe(12.5);
    expect(parseNum('۱٬۲۳۴٫۵۶')).toBe(1234.56);
  });

  it('converts Persian and Arabic digits', () => {
    expect(parseNum('۱۲۳')).toBe(123);
    expect(parseNum('١٢٣')).toBe(123);
    expect(parseNum('۱۲٫۵')).toBe(12.5);
  });

  it('leaves plain numbers alone', () => {
    expect(parseNum('1234')).toBe(1234);
    expect(parseNum('1234.5')).toBe(1234.5);
    expect(parseNum(-5)).toBe(-5);
    expect(parseNum(0)).toBe(0);
  });

  it('is NaN for an absent value rather than silently zero', () => {
    expect(Number.isNaN(parseNum(null))).toBe(true);
    expect(Number.isNaN(parseNum(undefined))).toBe(true);
    expect(Number.isNaN(parseNum(true))).toBe(true);
    expect(Number.isNaN(parseNum(''))).toBe(true);
    expect(Number.isNaN(parseNum('   '))).toBe(true);
  });
});