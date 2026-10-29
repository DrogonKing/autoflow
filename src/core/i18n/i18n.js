/**
 * Translation lookup, with the direction handled here rather than in every view.
 *
 * Design decisions, each because the alternative causes a specific problem:
 *
 *  - A MISSING KEY RETURNS THE KEY ITSELF, not an empty string. An empty button is invisible; `tab.history`
 *    sitting on screen is ugly but says exactly what is wrong and where. A test asserts the catalogues are
 *    complete, so this is a safety net rather than the normal path.
 *  - `t()` IS PURE AND TAKES THE LANGUAGE EXPLICITLY. Nothing reads a global, so every string can be checked
 *    in a unit test without a browser, a store, or a chrome API.
 *  - DIRECTION IS DERIVED, NOT PASSED. One place decides whether the document is RTL, so a view cannot get it
 *    wrong and a new view cannot forget it.
 */
import { CATALOGUES, LANGUAGES, RTL_LANGUAGES } from './catalogue.js';

export const DEFAULT_LANGUAGE = 'system';

/** Resolve `system` to a concrete language code this build actually ships. */
export function resolveLanguage(preference, browserLanguage) {
  if (preference && preference !== 'system' && CATALOGUES[preference]) return preference;
  const lang = String(browserLanguage || '').toLowerCase();
  // exact match first, then the primary subtag: 'fa-IR' -> 'fa'
  if (CATALOGUES[lang]) return lang;
  const primary = lang.split('-')[0];
  if (CATALOGUES[primary]) return primary;
  return 'en';
}

export function isRtl(language) {
  return RTL_LANGUAGES.has(String(language || '').toLowerCase().split('-')[0]);
}

export function direction(language) {
  return isRtl(language) ? 'rtl' : 'ltr';
}

/**
 * Look a key up.
 *
 * `vars` are substituted as `{name}`. A missing value is left as the literal `{name}` rather than becoming
 * "undefined", so a template mistake is visible instead of producing a sentence that reads as nonsense.
 */
export function translate(language, key, vars) {
  const catalogue = CATALOGUES[language] || CATALOGUES.en;
  let value = catalogue[key];
  if (value === undefined) value = CATALOGUES.en[key];
  if (value === undefined) return key; // visible, and a test should have caught it
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (m, name) =>
    (vars[name] === undefined || vars[name] === null ? m : String(vars[name])));
}

/**
 * `t` bound to a language, with a `has` so a caller can fall back deliberately.
 *
 * `has` exists for the STEP_LABELS case: the step model carries an English label for every kind, including
 * kinds added to the model but not yet to the catalogue. Falling through to that label keeps a new step kind
 * readable (`Fill field`) instead of printing `step.fill` on screen. Without `has` the caller cannot tell a
 * real translation from a missing-key fallback, because both are strings.
 */
export function translator(language) {
  const t = (key, vars) => translate(language, key, vars);
  t.language = language;
  t.rtl = isRtl(language);
  t.dir = direction(language);
  t.has = (key) => {
    const cat = CATALOGUES[language] || CATALOGUES.en;
    return cat[key] !== undefined || CATALOGUES.en[key] !== undefined;
  };
  return t;
}

/**
 * Apply the language to a document: `lang`, `dir`, and the font stack.
 *
 * Why the font matters and is not cosmetic: the default UI fonts on Windows and Linux frequently have no
 * Persian glyphs, so the text falls back per-glyph and the result is uneven spacing and disconnected letters.
 * Naming a Persian-capable family first fixes that, and listing a Latin family second keeps the Latin
 * technical terms (CSS, XPath, id) in the font that renders them best.
 */
export function applyToDocument(doc, language) {
  const dir = direction(language);
  doc.documentElement.setAttribute('lang', language);
  doc.documentElement.setAttribute('dir', dir);
  doc.documentElement.setAttribute('data-autoflow-lang', language);
  if (isRtl(language)) {
    doc.documentElement.style.setProperty('--af-font',
      'Vazirmatn, "Noto Naskh Arabic", "Segoe UI", Tahoma, "Iranian Sans", system-ui, sans-serif');
  } else {
    doc.documentElement.style.removeProperty('--af-font');
  }
  return { language, dir };
}

export { CATALOGUES, LANGUAGES, RTL_LANGUAGES };
