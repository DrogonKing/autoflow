import { describe, it, expect } from 'vitest';
/**
 * THE REAL FUNCTION, not a mirror of it.
 *
 * This test previously could not import the panel (`chrome.runtime.onMessage` runs at file scope and throws), so it held a
 * COPY of `normaliseDigits` and asserted the copy against a copy of the expectations. That cannot catch the fault it exists
 * for: the per-time gap field was written with `replace(/[^0-9]/g, '')`, rejected Persian digits, and this test kept passing
 * because the copy had never been wrong. There is now one definition, in a pure module, imported by both.
 */
import { normaliseDigits, digitsToNumber } from '../src/core/text/digits.js';

/**
 * PERSIAN AND ARABIC DIGITS, in the per-time gap field.
 *
 * Reported: "الان درست شد فقط اعداد فارسی قبول نمیکنه". The gap field parsed its value with `replace(/[^0-9]/g, '')`, which
 * keeps ASCII digits only - so ۲۰ from a Persian keyboard became an empty string and the value fell back to zero, silently.
 *
 * The project already had `normaliseDigits` for this, and the time field already used it. The gap field was written without
 * it, which is the gap a shared helper exists to prevent: one field remembering and another not is indistinguishable from a
 * bug for the person typing.
 *
 * These cases pin the helper's contract, because the field now depends on it and a future rewrite of either should fail here
 * rather than in the panel.
 */
describe('normaliseDigits — the one place non-ASCII digits become numbers', () => {
  it('Persian digits (U+06F0..) map to their ASCII equivalents', () => {
    expect(normaliseDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  it('Arabic-Indic digits (U+0660..) map too — a different keyboard, the same intent', () => {
    expect(normaliseDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
  });

  it('the two forms can be mixed with ASCII, which is what a half-typed field looks like', () => {
    expect(normaliseDigits('۲۰')).toBe('20');
    expect(normaliseDigits('۲0')).toBe('20');
    expect(normaliseDigits('2۰')).toBe('20');
  });

  it('a value that is already ASCII is untouched', () => {
    expect(normaliseDigits('20')).toBe('20');
    expect(normaliseDigits('0')).toBe('0');
  });

  it('non-digits are left for the caller to strip, not silently interpreted', () => {
    // the field strips afterwards; this function's job is only the digit mapping, so a minus sign survives to be rejected
    expect(normaliseDigits('-۵')).toBe('-5');
    expect(normaliseDigits('۱e۹')).toBe('1e۹'.replace('۹', '9'));
  });

  it('null and undefined are empty rather than the string "null"', () => {
    expect(normaliseDigits(null)).toBe('');
    expect(normaliseDigits(undefined)).toBe('');
  });
});

describe('what the gap field does with the normalised value', () => {
  /** The field's ACTUAL rule, called rather than restated: one definition, used by the panel and by this test. */
  const parseGap = (raw) => digitsToNumber(raw, { min: 0, max: 60_000 });

  it('۲۰ typed with a Persian keyboard is 20 ms, not zero', () => {
    // THIS IS THE REPORTED FAULT, exactly: it used to be 0
    expect(parseGap('۲۰')).toBe(20);
  });

  it('٢٠ with an Arabic keyboard is 20 ms', () => {
    expect(parseGap('٢٠')).toBe(20);
  });

  it('Persian digits above the clamp are clamped, not trusted', () => {
    // ۹۹۹۹۹۹ is 999999, above the 60 s ceiling
    expect(parseGap('۹۹۹۹۹۹')).toBe(60_000);
  });

  it('an empty or garbage value is zero rather than NaN', () => {
    expect(parseGap('')).toBe(0);
    expect(parseGap('abc')).toBe(0);
    expect(Number.isFinite(parseGap('abc'))).toBe(true);
  });

  it('a clean ASCII value still works, so the fix changes nothing for an English keyboard', () => {
    expect(parseGap('20')).toBe(20);
    expect(parseGap('0')).toBe(0);
  });
});