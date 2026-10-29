/**
 * The catalogues must be complete, and the check is a test because a half-translated UI is worse than an
 * English-only one: the user cannot tell whether a missing string is a bug or their own mistake.
 *
 * These tests also pin the parts of the contract that are easy to break later: placeholder names must match
 * between languages, the RTL decision must be a property of the language code, and a missing key must be
 * visible rather than blank.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUES, en, fa, LANGUAGES, RTL_LANGUAGES } from '../src/core/i18n/catalogue.js';
import { applyToDocument, direction, isRtl, resolveLanguage, translate, translator } from '../src/core/i18n/i18n.js';

describe('the message catalogues', () => {
  it('Persian has every key English has - no gaps to fall back on', () => {
    const missing = Object.keys(en).filter((k) => fa[k] === undefined);
    expect(missing, `untranslated: ${missing.join(', ')}`).toEqual([]);
  });

  it('Persian has no key English lacks', () => {
    // An orphan key means a rename happened in one file only, which silently drops a translation.
    const orphans = Object.keys(fa).filter((k) => en[k] === undefined);
    expect(orphans, `orphaned: ${orphans.join(', ')}`).toEqual([]);
  });

  it('a placeholder in one language exists in the other, with the same name', () => {
    const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const problems = [];
    for (const key of Object.keys(en)) {
      const a = names(en[key]);
      const b = names(fa[key] ?? '');
      if (a.join(',') !== b.join(',')) problems.push(`${key}: en[${a}] vs fa[${b}]`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('no value is empty or whitespace', () => {
    for (const [code, cat] of Object.entries(CATALOGUES)) {
      for (const [k, v] of Object.entries(cat)) {
        expect(v.trim(), `${code}.${k} is blank`).not.toBe('');
      }
    }
  });

  it('technical terms stay in Latin script in Persian, because they are matched against DevTools', () => {
    // not cosmetic: the user reads these next to the browser's own inspector and the English docs
    for (const term of ['CSS', 'XPath', 'id', 'name', 'label', 'aria-label', 'role', 'cron', 'JSON']) {
      const key = Object.keys(en).find((k) => en[k] === term)
        ?? ({ CSS: 'find.css', XPath: 'find.xpath' }[term]);
      if (key && fa[key]) {
        expect(fa[key], `${key} should keep the Latin term`).toContain(term);
      }
    }
  });
});

describe('language resolution', () => {
  it('an explicit choice wins', () => {
    expect(resolveLanguage('fa', 'en-US')).toBe('fa');
    expect(resolveLanguage('en', 'fa-IR')).toBe('en');
  });

  it('system follows the browser, including a region subtag', () => {
    expect(resolveLanguage('system', 'fa-IR')).toBe('fa');
    expect(resolveLanguage('system', 'fa')).toBe('fa');
    expect(resolveLanguage('system', 'en-GB')).toBe('en');
  });

  it('an unsupported browser language falls back to English rather than to nothing', () => {
    expect(resolveLanguage('system', 'de-DE')).toBe('en');
    expect(resolveLanguage('system', '')).toBe('en');
    expect(resolveLanguage(undefined, undefined)).toBe('en');
  });

  it('an unknown preference is treated as system rather than as a crash', () => {
    expect(resolveLanguage('klingon', 'fa')).toBe('fa');
  });
});

describe('direction', () => {
  it('Persian is right-to-left, English is not', () => {
    expect(isRtl('fa')).toBe(true);
    expect(isRtl('fa-IR')).toBe(true);
    expect(isRtl('en')).toBe(false);
    expect(direction('fa')).toBe('rtl');
    expect(direction('en')).toBe('ltr');
  });

  it('applyToDocument sets lang and dir, and a Persian font stack only for RTL', () => {
    const doc = {
      documentElement: {
        attrs: {},
        style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } },
        setAttribute(k, v) { this.attrs[k] = v; },
      },
    };
    applyToDocument(doc, 'fa');
    expect(doc.documentElement.attrs.dir).toBe('rtl');
    expect(doc.documentElement.attrs.lang).toBe('fa');
    expect(doc.documentElement.style.props['--af-font']).toContain('Vazirmatn');

    applyToDocument(doc, 'en');
    expect(doc.documentElement.attrs.dir).toBe('ltr');
    expect(doc.documentElement.style.props['--af-font']).toBeUndefined();
  });
});

describe('translation', () => {
  it('substitutes named placeholders', () => {
    expect(translate('en', 'msg.imported', { n: 3 })).toBe('Imported 3');
    expect(translate('fa', 'msg.imported', { n: 3 })).toBe('3 مورد وارد شد');
  });

  it('leaves an unsupplied placeholder visible rather than printing undefined', () => {
    // a sentence reading "...skip  now" hides the bug; "{k}" shows it
    const out = translate('en', 'msg.importedSkipped', { n: 1, names: 'a' });
    expect(out).toContain('{k}');
    expect(out).not.toContain('undefined');
  });

  it('a missing key returns the key, so the gap is visible in the UI and in a test', () => {
    expect(translate('fa', 'no.such.key')).toBe('no.such.key');
  });

  it('an unknown language falls back to English rather than throwing', () => {
    expect(translate('xx', 'action.save')).toBe('Save');
  });

  it('the translator carries the language and direction with it', () => {
    const t = translator('fa');
    expect(t.language).toBe('fa');
    expect(t.rtl).toBe(true);
    expect(t.dir).toBe('rtl');
    expect(t('action.save')).toBe('ذخیره');
  });

  it('every offered language is either a real catalogue or the system option', () => {
    for (const { code } of LANGUAGES) {
      if (code === 'system') continue;
      expect(CATALOGUES[code], `${code} is offered but has no catalogue`).toBeTruthy();
    }
  });

  it('RTL is decided by the language code, not by a list kept in a view', () => {
    expect(RTL_LANGUAGES.has('fa')).toBe(true);
    expect(RTL_LANGUAGES.has('en')).toBe(false);
  });
});
