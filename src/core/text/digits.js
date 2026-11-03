/**
 * Keyboard digits, normalised.
 *
 * WHY THIS IS A MODULE OF ITS OWN, and not a helper inside the panel:
 *
 * The panel runs `chrome.runtime.onMessage` at file scope, so importing it in a unit test throws before any test executes.
 * The tests therefore MIRRORED these functions - a copy of the code, asserted against a copy of the expectations - which
 * cannot catch the bug it exists to catch, because the copy is corrected by whoever writes the next test. Measured: the
 * per-time gap field was written with `replace(/[^0-9]/g, '')` and rejected Persian digits while the mirror in
 * `pick-and-digits.test.js` kept passing, because the mirror had never been wrong.
 *
 * A pure module can be imported by the panel AND by the tests, so there is one definition and it is the one that runs.
 *
 * THE DIGITS ARE INTERFACE, NOT DATA. ۰۱۲۳ is a keyboard convention, not a number system the extension should store, so the
 * mapping happens on the way in. Only digit characters are translated: a malformed time stays malformed and is rejected by
 * the usual validation rather than being silently rewritten into a valid one.
 */

/** Persian (U+06F0..U+06F9) and Arabic-Indic (U+0660..U+0669) digits to ASCII, nothing else touched. */
export function normaliseDigits(text) {
  return String(text ?? '')
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * A whole number from text that may use any of the three digit sets, clamped to a range.
 *
 * Used by the fields that take a small non-negative number - a click gap in milliseconds, a retry count. `NaN`, an empty
 * field and pure garbage all become `min`, so a field the user has not filled behaves like zero rather than like an error.
 */
export function digitsToNumber(text, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const digits = normaliseDigits(text).replace(/[^0-9]/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}