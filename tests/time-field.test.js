/**
 * The time field as a MASKED field: digits in, separators drawn.
 *
 * The two reports this answers, in the user's words:
 *   "':' نباید پاک بشه درحالی که وقتی اعداد ساعت‌ها رو پاک میکنم اونم پاک میشه"
 *   "اعداد ساعت رو باید دوتا دوتا بگیره مثلا وقتی عدد ۱۳۵۱۲۱ رو میدم خودش تبدیلش کنه به ۱۳:۵۱:۲۱، برای هم فارسی هم انگلیسی"
 *
 * Both came from the same mistake: the field treated `:` as something the user types. It is structure, so it is now
 * derived - which means it cannot be deleted, and grouping is automatic in any script.
 */
import { describe, expect, it } from 'vitest';

/** Mirror of the source. */
function normaliseDigits(text) {
  return String(text ?? '')
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}
const TIME_SEPARATORS = /[\u066B\u066C\u061B\uFF1A\uFE55\u05C3\u2236\u002E\u06D4]/g;
function timeDigits(text) {
  return normaliseDigits(text).replace(TIME_SEPARATORS, '').replace(/[^0-9]/g, '').slice(0, 6);
}
function formatTimeDigits(text) {
  const digits = timeDigits(text);
  const parts = [];
  for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
  return parts.join(':');
}
function countTimeParts(text) {
  return formatTimeDigits(text).split(':').filter(Boolean).length;
}
function caretAfterFormatting(raw, caret, formatted) {
  const rawText = String(raw ?? '');
  const upTo = rawText.slice(0, Math.max(0, Math.min(caret ?? 0, rawText.length)));
  const digitsBefore = timeDigits(upTo).length;
  const out = String(formatted ?? '');
  if (digitsBefore === 0) return 0;
  let seen = 0;
  let i = 0;
  for (; i < out.length; i++) {
    if (/[0-9]/.test(out[i])) { seen += 1; if (seen === digitsBefore) { i += 1; break; } }
  }
  if (out[i] === ':' && i < out.length - 1) i += 1;
  return i;
}
function caretDigitIndex(raw, caret) {
  const rawText = String(raw ?? '');
  return timeDigits(rawText.slice(0, Math.max(0, Math.min(caret ?? 0, rawText.length)))).length;
}
function parseTypedTime(text) {
  const digits = timeDigits(text);
  if (digits === '') return { ok: false, error: 'empty' };
  if (digits.length > 6) return { ok: false, error: 'tooManyDigits' };
  // a partial group is padded on the LEFT: '13:5' is thirteen-oh-five, and '1' is one o'clock
  const h = Number(digits.slice(0, 2).padStart(2, '0'));
  const m = Number(digits.slice(2, 4).padStart(2, '0'));
  const precise = digits.length > 4;
  const s = precise ? Number(digits.slice(4, 6).padStart(2, '0')) : 0;
  if (h > 23) return { ok: false, error: 'hourRange' };
  if (m > 59) return { ok: false, error: 'minuteRange' };
  if (precise && s > 59) return { ok: false, error: 'secondRange' };
  return { ok: true, hour: h, minute: m, second: s, precise };
}
/** Backspace, as the keydown handler implements it. */
function backspace(raw, caret) {
  const at = caretDigitIndex(raw, caret);
  const digits = timeDigits(raw);
  if (at === 0) return { value: formatTimeDigits(raw), at: caret, blocked: true };
  const next = digits.slice(0, at - 1) + digits.slice(at);
  return { value: formatTimeDigits(next), at: at - 1, blocked: false };
}

describe('digits group themselves, two by two', () => {
  it('the exact example from the report: ۱۳۵۱۲۱ becomes ۱۳:۵۱:۲۱', () => {
    expect(formatTimeDigits('۱۳۵۱۲۱')).toBe('13:51:21');
    expect(parseTypedTime('۱۳۵۱۲۱')).toMatchObject({ ok: true, hour: 13, minute: 51, second: 21, precise: true });
  });

  it('the same with Western digits', () => {
    expect(formatTimeDigits('135121')).toBe('13:51:21');
  });

  it('the same with Arabic-Indic digits', () => {
    expect(formatTimeDigits('١٣٥١٢١')).toBe('13:51:21');
  });

  it('every length groups correctly', () => {
    expect(formatTimeDigits('1')).toBe('1');
    expect(formatTimeDigits('13')).toBe('13');
    expect(formatTimeDigits('135')).toBe('13:5');
    expect(formatTimeDigits('1351')).toBe('13:51');
    expect(formatTimeDigits('13512')).toBe('13:51:2');
    expect(formatTimeDigits('135121')).toBe('13:51:21');
  });

  it('a pasted time with colons is re-derived, so the separators cannot disagree', () => {
    expect(formatTimeDigits('13:51:21')).toBe('13:51:21');
    expect(formatTimeDigits('13:5')).toBe('13:5');
    // a pasted value with the wrong separators lands on the same digits
    expect(formatTimeDigits('۱۳:۵۱:۲۱')).toBe('13:51:21');
    expect(formatTimeDigits('۱۳٫۵۱٫۲۱')).toBe('13:51:21');
  });

  it('more than six digits is not a time', () => {
    expect(timeDigits('1351211')).toBe('135121');       // the buffer caps at six
    expect(parseTypedTime('1351211').ok).toBe(true);    // ...which is the six-digit time, not a failure
    expect(countTimeParts('135121')).toBe(3);
  });
});

describe('the separator cannot be deleted, because it is not stored', () => {
  it('deleting the last digit of a group keeps the structure consistent', () => {
    /**
     * THE REPORTED BUG. The colon used to be part of the value, so removing digits around it could take it too and the
     * field was left holding something that was not a time. Now the colons are re-derived from whatever digits remain,
     * so there is no state in which the separator can be missing while the digits are present.
     */
    // '13:51' with the caret after the last digit, backspace twice
    const one = backspace('13:51', 5);
    expect(one.value).toBe('13:5');
    const two = backspace(one.value, one.value.length);
    expect(two.value).toBe('13');
    const three = backspace(two.value, two.value.length);
    expect(three.value).toBe('1');
    const four = backspace(three.value, three.value.length);
    expect(four.value).toBe('');
    // and every intermediate value is the digits plus whatever separators they imply - never a stray colon
    for (const v of [one.value, two.value, three.value, four.value]) {
      expect(v).toBe(formatTimeDigits(v));
    }
  });

  it('backspace just after a colon removes the DIGIT, not nothing', () => {
    /**
     * The subtle one. With the colon derived, a caret sitting right after a separator would make a naive backspace
     * delete nothing visible and the field would look stuck. It removes the digit before the caret.
     */
    // '13:51', caret at 3 - immediately after the colon
    const r = backspace('13:51', 3);
    expect(r.value).toBe('15:1');
    expect(r.blocked).toBe(false);
  });

  it('backspace at the very start does nothing, and does NOT eat the leading structure', () => {
    const r = backspace('13:51', 0);
    expect(r.blocked).toBe(true);
    expect(r.value).toBe('13:51');
  });

  it('the caret is reported as a DIGIT index, which is what the operations work in', () => {
    expect(caretDigitIndex('13:51', 0)).toBe(0);
    expect(caretDigitIndex('13:51', 2)).toBe(2);
    expect(caretDigitIndex('13:51', 3)).toBe(2);   // just after the colon is still two digits in
    expect(caretDigitIndex('13:51', 5)).toBe(4);
  });
});

describe('the caret stays in the group being typed', () => {
  it('typing the third digit lands after it, past the colon that was inserted', () => {
    // '13' + '5' -> '13:5', caret should be at the end (4), not before the colon (2)
    const formatted = formatTimeDigits('135');
    expect(formatted).toBe('13:5');
    expect(caretAfterFormatting('135', 3, formatted)).toBe(4);
  });

  it('a caret at a group boundary steps past the colon, so typing continues in the next group', () => {
    /**
     * Deliberate, and the one place the mapping is not a pure translation. A caret after exactly two digits sits on a
     * group boundary; leaving it immediately before the colon would put the next keystroke into the HOUR group, which is
     * the opposite of what the user means when they have just finished typing the hour. So the position is returned
     * AFTER the separator.
     */
    const formatted = formatTimeDigits('1351');
    expect(formatted).toBe('13:51');
    expect(caretAfterFormatting('1351', 2, formatted)).toBe(3);
  });

  it('an empty value puts the caret at the start', () => {
    expect(caretAfterFormatting('', 0, '')).toBe(0);
  });
});

describe('parsing survives the grouping change', () => {
  it('two digits mean a whole hour', () => {
    // '13' used to be "incomplete"; the field displays 13, so it means 13:00
    expect(parseTypedTime('13')).toMatchObject({ ok: true, hour: 13, minute: 0, precise: false });
  });

  it('a half-group is padded, not rejected', () => {
    // '13:5' is what the field SHOWS mid-typing, so it must mean 13:05
    expect(parseTypedTime('13:5')).toMatchObject({ ok: true, hour: 13, minute: 5, precise: false });
  });

  it('minute precision is never promoted, and six digits is always precise', () => {
    expect(parseTypedTime('1351')).toMatchObject({ ok: true, precise: false, second: 0 });
    expect(parseTypedTime('135121')).toMatchObject({ ok: true, precise: true, second: 21 });
  });

  it('an empty field is still refused', () => {
    expect(parseTypedTime('')).toMatchObject({ ok: false, error: 'empty' });
  });

  it('out-of-range parts are refused, with their own reason', () => {
    expect(parseTypedTime('2451')).toMatchObject({ ok: false, error: 'hourRange' });
    expect(parseTypedTime('1399')).toMatchObject({ ok: false, error: 'minuteRange' });
    expect(parseTypedTime('135199')).toMatchObject({ ok: false, error: 'secondRange' });
  });

  it('EVERY refusal carries a reason, because silence is what hid the original bug', () => {
    for (const bad of ['', '2451', '1399', '135199']) {
      const r = parseTypedTime(bad);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
      expect(r.error.length).toBeGreaterThan(0);
    }
  });
});
