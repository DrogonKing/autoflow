/**
 * THE WINDOW TAB'S STRINGS EXIST IN BOTH LANGUAGES, and the tab does not leak a key into the interface.
 *
 * WHY THIS IS ITS OWN TEST: the project's translation helper is deliberately transparent - a missing key falls back to the KEY
 * NAME, so a forgotten string shows `window.save` on the button. In Persian that means the primary language of the user shows an
 * English identifier. It is invisible to any test that only renders in one language, and it is exactly the class of defect the
 * project's own language test was written for.
 *
 * The list of keys is read from the PANEL, not written here: a key added to the view is covered the moment it is used, and a key
 * removed from the view stops being demanded. A hand-maintained list would drift in the first direction and lie in the second.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { en, fa } from '../src/core/i18n/catalogue.js';

/**
 * THE PANEL IS READ FROM DISK rather than imported, because importing it runs `chrome.runtime.onMessage.addListener` at file
 * scope and the module cannot be loaded outside a browser. Reading the source is what lets this test see EVERY key the view asks
 * for without depending on the view being loadable - the same reason the project's digit helper was extracted to its own module.
 */
const panel = readFileSync(resolve(process.cwd(), 'src/ui/panel/panel.js'), 'utf8');

/** Every `t('...')` key the panel asks for. */
const usedKeys = new Set([...panel.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]));

/** Every key the window view asks for, by name, so the coverage is visible rather than implied. */
const windowKeys = [...usedKeys].filter((k) => k.startsWith('window.') || k === 'tab.window');

describe('the Window tab does not leak an untranslated key', () => {
  it('the tab actually asks for strings', () => {
    // a guard against the test passing because the view was renamed and nothing was found
    expect(windowKeys.length).toBeGreaterThan(10);
    expect(windowKeys).toContain('window.start');
    expect(windowKeys).toContain('window.end');
    expect(windowKeys).toContain('window.save');
    expect(windowKeys).toContain('window.stop');
  });

  it('every key it uses is in the ENGLISH catalogue', () => {
    const missing = windowKeys.filter((k) => !(k in en));
    expect(missing, `missing from en: ${missing.join(', ')}`).toEqual([]);
  });

  it('every key it uses is in the PERSIAN catalogue', () => {
    // this is the one that matters: a missing key shows its own name, and Persian is the interface's primary language
    const missing = windowKeys.filter((k) => !(k in fa));
    expect(missing, `missing from fa: ${missing.join(', ')}`).toEqual([]);
  });

  it('the two catalogues agree on the tab keys, so switching language does not change the tabs', () => {
    for (const k of ['tab.basic', 'tab.window', 'tab.automations']) {
      expect(en[k], `en is missing ${k}`).toBeTruthy();
      expect(fa[k], `fa is missing ${k}`).toBeTruthy();
    }
  });

  it('no string is left as its own key name, in either language', () => {
    /**
     * The leak, stated directly: a value identical to its key is what the helper returns when a translation is absent. Checked
     * for the window keys only, because a few older keys elsewhere in the catalogue may legitimately read the same in both.
     */
    for (const k of windowKeys) {
      expect(en[k], `en['${k}'] leaks the key`).not.toBe(k);
      expect(fa[k], `fa['${k}'] leaks the key`).not.toBe(k);
    }
  });

  it('the Persian strings are actually Persian, not English left in place', () => {
    /**
     * A copy-paste that fills both blocks with the English text passes every check above. Persian uses the Arabic script, so a
     * non-ASCII character is the cheap honest signal; the label keys are short enough that this is reliable.
     */
    const labels = ['window.start', 'window.end', 'window.points', 'window.save', 'window.stop', 'tab.window'];
    for (const k of labels) {
      expect(/[^\u0000-\u007F]/.test(fa[k]), `fa['${k}'] is not Persian: ${JSON.stringify(fa[k])}`).toBe(true);
    }
  });

  it('the error keys the model can produce all have a string, so a failure is never a raw code', () => {
    /**
     * `buildWindowPlan` reports `invalid-time`, `invalid-end` and `end-before-start`, and the view looks up `window.err.<code>`.
     * A code without a string would show `window.err.end-before-start` to the user at the exact moment they need to read it.
     */
    for (const code of ['invalid-time', 'invalid-end', 'end-before-start']) {
      expect(en[`window.err.${code}`], `en is missing window.err.${code}`).toBeTruthy();
      expect(fa[`window.err.${code}`], `fa is missing window.err.${code}`).toBeTruthy();
    }
  });

  it('the summary templates carry the placeholders the view substitutes', () => {
    for (const k of ['window.sum.endless', 'window.sum.finite']) {
      expect(en[k]).toContain('{start}');
      expect(fa[k]).toContain('{start}');
      expect(en[k]).not.toBe(fa[k]);
    }
    expect(en['window.sum.finite']).toContain('{end}');
    expect(fa['window.sum.finite']).toContain('{end}');
  });
});
