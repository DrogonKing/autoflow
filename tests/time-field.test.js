/**
 * The time field, taken seriously.
 *
 * Every case here comes from a real session, and the first group is the one that broke the reported run: a Persian
 * keyboard sends a separator that is NOT ':' and it was being deleted, so the whole value became a single number,
 * was rejected in silence, and the model kept the 09:00:00 default - which had already passed, so the schedule armed
 * for tomorrow and nothing ran.
 */
import { describe, expect, it } from 'vitest';

/** Mirror of the source. */
function normaliseDigits(text) {
  return String(text ?? '')
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}
const TIME_SEPARATORS = /[\u066B\u066C\u061B\uFF1A\uFE55\u05C3\u2236\u002E\u06D4]/g;
function normaliseTimeText(text) {
  return normaliseDigits(text).replace(TIME_SEPARATORS, ':').replace(/[^0-9:]/g, '').replace(/:{2,}/g, ':').slice(0, 8);
}
function parseTypedTime(text) {
  const normalised = normaliseTimeText(text);
  if (normalised === '') return { ok: false, error: 'empty' };
  // checked before the field's 8-character limit can truncate a fourth part into a valid-looking time
  const unbounded = normaliseDigits(text).replace(TIME_SEPARATORS, ':').replace(/[^0-9:]/g, '');
  if (unbounded.length > 8) return { ok: false, error: 'tooManyDigits' };
  const rawParts = normalised.split(':');
  if (rawParts.some((p) => p === '')) return { ok: false, error: 'incomplete' };
  if (rawParts.length > 3) return { ok: false, error: 'tooManyParts' };
  if (rawParts.length < 2) return { ok: false, error: 'incomplete' };
  if (rawParts.some((p) => p.length > 2)) return { ok: false, error: 'tooManyDigits' };
  const [h, m, s] = rawParts.map(Number);
  if (h > 23) return { ok: false, error: 'hourRange' };
  if (m > 59) return { ok: false, error: 'minuteRange' };
  if (rawParts.length > 2 && s > 59) return { ok: false, error: 'secondRange' };
  return { ok: true, hour: h, minute: m, second: rawParts.length > 2 ? s : 0, precise: rawParts.length > 2 };
}
function caretsAfterNormalising(raw, caret, normalised) {
  const text = String(raw ?? '');
  const upTo = text.slice(0, Math.max(0, Math.min(caret ?? 0, text.length)));
  return Math.max(0, Math.min(normaliseTimeText(upTo).length, String(normalised ?? '').length));
}

describe('separators a non-Western keyboard actually produces', () => {
  /**
   * THE BUG THAT BROKE THE RUN. Each of these is a character a keyboard can send where a Western keyboard has ':'. All
   * of them used to be deleted, turning '۱۲:۳۰' into '1230' - not a time, so the value was rejected and the model never
   * changed.
   */
  const separators = [
    ['U+066B arabic decimal', '\u066B'],
    ['U+066C arabic thousands', '\u066C'],
    ['U+061B arabic semicolon', '\u061B'],
    ['U+FF1A fullwidth colon', '\uFF1A'],
    ['U+FE55 small colon', '\uFE55'],
    ['U+05C3 hebrew punctuation', '\u05C3'],
    ['U+2236 ratio', '\u2236'],
    ['U+06D4 arabic full stop', '\u06D4'],
  ];

  for (const [name, ch] of separators) {
    it(`${name} is read as a colon, not deleted`, () => {
      expect(parseTypedTime(`۱۲${ch}۳۰`)).toMatchObject({ ok: true, hour: 12, minute: 30 });
    });
  }

  it('a plain ASCII colon still works', () => {
    expect(parseTypedTime('12:30')).toMatchObject({ ok: true, hour: 12, minute: 30 });
  });

  it('the digits are still translated for a Persian keyboard', () => {
    expect(parseTypedTime('۰۸:۴۵:۵۲')).toMatchObject({ ok: true, hour: 8, minute: 45, second: 52 });
  });
});

describe('values that must NOT be accepted', () => {
  /**
   * Each of these was accepted before, and acceptance is worse than rejection here: a schedule was written that the
   * user never asked for, and it looked fine.
   */
  it('an empty field is not midnight', () => {
    expect(parseTypedTime('')).toMatchObject({ ok: false, error: 'empty' });
    expect(parseTypedTime('   ')).toMatchObject({ ok: false, error: 'empty' });
  });

  it('a single separator is NOT 00:00', () => {
    // ':' used to produce model 0:0, i.e. midnight, from one keystroke
    expect(parseTypedTime(':')).toMatchObject({ ok: false });
  });

  it('a trailing separator is incomplete, not clamped', () => {
    // '۱۲:' used to produce 12:0
    expect(parseTypedTime('۱۲:')).toMatchObject({ ok: false, error: 'incomplete' });
    expect(parseTypedTime('12:30:')).toMatchObject({ ok: false, error: 'incomplete' });
  });

  it('a half-written hour is incomplete', () => {
    expect(parseTypedTime('۱')).toMatchObject({ ok: false });
  });

  it('an out-of-range minute is refused, not wrapped', () => {
    expect(parseTypedTime('12:100')).toMatchObject({ ok: false, error: 'tooManyDigits' });
    expect(parseTypedTime('12:99')).toMatchObject({ ok: false, error: 'minuteRange' });
  });

  it('an out-of-range hour is refused', () => {
    expect(parseTypedTime('24:00')).toMatchObject({ ok: false, error: 'hourRange' });
    expect(parseTypedTime('۹۹:۰۰')).toMatchObject({ ok: false, error: 'hourRange' });
  });

  it('an out-of-range second is refused', () => {
    expect(parseTypedTime('12:30:99')).toMatchObject({ ok: false, error: 'secondRange' });
  });

  it('a four-part value is refused rather than truncated', () => {
    // '۱۴:۳۰:۵۵:۹۹' used to be silently cut to 14:30:55
    expect(parseTypedTime('۱۴:۳۰:۵۵:۹۹')).toMatchObject({ ok: false });
  });

  it('a stray letter is IGNORED rather than made fatal', () => {
    /**
     * Deliberate tolerance: a keyboard can produce a character that is not a digit, and refusing the whole value for it
     * would be worse than ignoring it - provided nothing is invented. `12:3x0` is read as the `12:30` the user meant,
     * and a value that is nothing BUT letters becomes empty and is refused.
     */
    expect(parseTypedTime('12:3x0')).toMatchObject({ ok: true, hour: 12, minute: 30 });
    expect(parseTypedTime('ab')).toMatchObject({ ok: false, error: 'empty' });
  });

  it('EVERY rejection carries a reason, because silence is what hid the original bug', () => {
    for (const bad of ['', ':', '۱', '۱۲:', '12:99', '24:00', '12:30:99', '۱۴:۳۰:۵۵:۹۹', 'ab', '12:100']) {
      const r = parseTypedTime(bad);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
      expect(r.error.length).toBeGreaterThan(0);
    }
  });
});

describe('minute precision is never silently promoted', () => {
  it('9:00 stays minute precision, with no invented second', () => {
    /**
     * This mattered: `wantsPreciseTiming` keys off whether the value has a third part, so inventing second=0 turned a
     * minute-precision schedule into a precise one - a different kind of schedule, produced by a parse.
     */
    const r = parseTypedTime('9:00');
    expect(r).toMatchObject({ ok: true, hour: 9, minute: 0, second: 0, precise: false });
  });

  it('09:00:00 is precise', () => {
    expect(parseTypedTime('09:00:00')).toMatchObject({ ok: true, precise: true, second: 0 });
  });

  it('a one-digit hour is accepted, as a person types it', () => {
    expect(parseTypedTime('9:30')).toMatchObject({ ok: true, hour: 9, minute: 30 });
  });
});

describe('the caret follows the typing', () => {
  /**
   * Reported: "when I type with the Persian keyboard it starts from the right instead of like English". Part of that is
   * CSS (`unicode-bidi: plaintext`), and part is this: the caret was placed by a boolean "was it at the end" test, which
   * is wrong as soon as normalisation changes a character in place.
   */
  it('stays at the position the user is editing, not at an end', () => {
    // typing '۳' into an empty field: caret after it must be after the normalised '3'
    expect(caretsAfterNormalising('۳', 1, '3')).toBe(1);
  });

  it('maps across a separator being replaced', () => {
    const raw = '۱۲\u066B۳۰';
    const norm = normaliseTimeText(raw);
    expect(norm).toBe('12:30');
    // caret after the '۱۲' and the separator is at index 3 in the raw text
    expect(caretsAfterNormalising(raw, 3, norm)).toBe(3);
  });

  it('shifts back when a rejected character is deleted before the caret', () => {
    // 'ab' is deleted, so a caret at 2 in the raw text is at 0 in the normalised one
    expect(caretsAfterNormalising('ab', 2, '')).toBe(0);
  });

  it('never returns a position outside the normalised text', () => {
    expect(caretsAfterNormalising('۱۲:۳۰', 99, '12:30')).toBe(5);
    expect(caretsAfterNormalising('', 5, '')).toBe(0);
    expect(caretsAfterNormalising(null, null, '12')).toBe(0);
  });
});
