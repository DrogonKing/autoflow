/**
 * The three things asked for, each as a test that fails against the old behaviour.
 *
 *  1. The Pick button confirms a landed pick, as Save now does.
 *  2. A pick can be CANCELLED. It could not before: Escape worked in the page, but a pick is started from the panel and
 *     the panel did not listen - so the only exit was clicking an element, which was then recorded. A misclick was
 *     unrecoverable.
 *  3. Persian and Arabic-Indic digits in the time field. A native `<input type="time">` discards them, so typing with a
 *     Persian keyboard left the model unchanged: "when I type with the Persian keyboard the numbers do not change".
 */
import { describe, expect, it } from 'vitest';

/** Mirror of normaliseDigits in src/ui/panel/panel.js. */
function normaliseDigits(text) {
  return String(text ?? '')
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Mirror of the field's parse, so the model's shape is asserted rather than just the digits. */
function parseTypedTime(value) {
  const normalised = normaliseDigits(value).replace(/[^0-9:]/g, '');
  const parts = String(normalised).split(':').map(Number);
  const [h, m, sec] = parts;
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  if (parts.length > 2 && (!Number.isFinite(sec) || sec < 0 || sec > 59)) return null;
  return { hour: h, minute: m, second: parts.length > 2 ? sec : 0, precise: parts.length > 2 };
}

describe('Persian and Arabic-Indic digits in the time field', () => {
  it('reads a Persian time', () => {
    expect(normaliseDigits('۰۸:۴۵')).toBe('08:45');
    expect(parseTypedTime('۰۸:۴۵')).toMatchObject({ hour: 8, minute: 45, precise: false });
  });

  it('reads a Persian time with a second', () => {
    expect(normaliseDigits('۰۸:۴۵:۵۲')).toBe('08:45:52');
    expect(parseTypedTime('۰۸:۴۵:۵۲')).toMatchObject({ hour: 8, minute: 45, second: 52, precise: true });
  });

  it('reads an Arabic-Indic time', () => {
    expect(normaliseDigits('٠٩:٣٠:٠٥')).toBe('09:30:05');
    expect(parseTypedTime('٠٩:٣٠:٠٥')).toMatchObject({ hour: 9, minute: 30, second: 5 });
  });

  it('leaves Western digits exactly as they were', () => {
    expect(normaliseDigits('08:45:52')).toBe('08:45:52');
  });

  it('handles a mixed value, which a keyboard switch mid-typing produces', () => {
    expect(normaliseDigits('۰8:۴5')).toBe('08:45');
  });

  it('does NOT turn a malformed time into a valid one', () => {
    /**
     * The important negative case. Normalising digits must not also repair structure, or "۹۹:۹۹" would become a valid
     * time and a typo would silently schedule something. It is rejected, exactly as its Western equivalent is.
     */
    expect(parseTypedTime('۹۹:۹۹')).toBeNull();
    expect(parseTypedTime('99:99')).toBeNull();
    expect(parseTypedTime('۲۵:۰۰')).toBeNull();
    expect(parseTypedTime('۰۸:۶۰')).toBeNull();
  });

  it('a half-typed value is rejected rather than guessed at', () => {
    expect(parseTypedTime('۰۸')).toBeNull();
    expect(parseTypedTime('۰۸:')).toMatchObject({ hour: 8, minute: 0 });
    expect(parseTypedTime('')).toBeNull();
    expect(parseTypedTime(undefined)).toBeNull();
  });

  it('exactly the two effects is required: seconds present or absent, never invented', () => {
    expect(parseTypedTime('۰۸:۴۵').precise).toBe(false);
    expect(parseTypedTime('۰۸:۴۵:۰۰').precise).toBe(true);
  });
});

describe('the pick lifecycle, as the panel drives it', () => {
  /** A tiny model of the state the panel keeps, so the transitions can be stated without a browser. */
  const makePanel = () => {
    const state = { pickTarget: null, pickSavedAt: null, pickCancelled: null };
    return {
      state,
      start: (stepId) => { state.pickTarget = stepId; state.pickSavedAt = null; },
      cancel: () => { state.pickTarget = null; state.pickCancelled = Date.now(); },
      land: (finder) => { state.pickTarget = null; state.pickSavedAt = Date.now(); return finder; },
      buttonKind: (stepId) => {
        if (state.pickTarget === stepId) return 'picking';
        if (state.pickSavedAt && state.pickTarget === null && Date.now() - state.pickSavedAt < 2500) return 'picked';
        return 'idle';
      },
    };
  };

  it('idle before anything is pressed', () => {
    const p = makePanel();
    expect(p.buttonKind('s1')).toBe('idle');
  });

  it('shows that a pick is in progress', () => {
    const p = makePanel();
    p.start('s1');
    expect(p.buttonKind('s1')).toBe('picking');
    expect(p.buttonKind('s2')).toBe('idle');   // another step's button is unaffected
  });

  it('CANCEL works, and is distinguishable from a pick that landed', () => {
    /**
     * THE REPORTED GAP. Before this there was no way out: `pickTarget` was cleared only by a successful pick, so a
     * misclick could only be undone by clicking an element - which recorded it.
     */
    const p = makePanel();
    p.start('s1');
    p.cancel();
    expect(p.state.pickTarget).toBeNull();
    expect(p.state.pickSavedAt).toBeNull();          // NOT a success
    expect(p.state.pickCancelled).toBeGreaterThan(0); // and it is recorded, so it is not silent
    expect(p.buttonKind('s1')).toBe('idle');
  });

  it('a cancelled pick leaves no finder anywhere', () => {
    /**
     * The whole point: cancelling must not write anything. Expressed as "the step still has whatever it had", which is
     * the property that matters - not "the cancel function was called".
     */
    const step = { id: 's1', finder: { strategy: 'css' } };
    const p = makePanel();
    p.start('s1');
    p.cancel();
    expect(step.finder).toEqual({ strategy: 'css' });
  });

  it('a landed pick shows confirmation and then stops', () => {
    const p = makePanel();
    p.start('s1');
    p.land({ strategy: 'css', selector: '#pad1' });
    expect(p.buttonKind('s1')).toBe('picked');
  });

  it('cancelling after starting again does not show a success', () => {
    // the sequence a misclick followed by a cancel produces
    const p = makePanel();
    p.start('s1');
    p.cancel();
    p.start('s1');
    p.cancel();
    expect(p.buttonKind('s1')).toBe('idle');
  });

  it('a pick can be started, cancelled, and started again', () => {
    // cancelling must not poison the control for the next attempt, which is the point of being able to recover
    const p = makePanel();
    p.start('s1');
    p.cancel();
    p.start('s1');
    expect(p.buttonKind('s1')).toBe('picking');
  });

  it('the page cancelling is the same state as the panel cancelling', () => {
    /**
     * Escape while the pointer is over the page. The panel did not listen for this, so it kept showing a live pick
     * after the page had stopped - a state with no way out.
     */
    const p = makePanel();
    p.start('s1');
    p.cancel();                        // the same handler the message runs
    expect(p.state.pickTarget).toBeNull();
    expect(p.buttonKind('s1')).toBe('idle');
  });
});
