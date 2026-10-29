#!/usr/bin/env node
/**
 * Does the Persian UI actually render, or does it only pass a static scan?
 *
 * A static scan proves no English literal is left in the source. It cannot prove that:
 *   - `t` is bound before the first render (a stale English `t` would pass the scan and paint English)
 *   - `dir` reaches <html>, which is what mirrors the layout
 *   - the language preference is read from settings and honoured
 *   - the strings the user sees are the Persian ones, not the keys
 *
 * So this loads the extension in a real Chromium, switches the stored language to `fa`, and reads the
 * rendered text of both pages. Then it asserts on what a Persian reader would actually see, including that
 * the step-kind names - which come from a label map rather than a literal - are translated.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.AUTOFLOW_CHROMIUM ||
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

const profile = mkdtempSync(path.join(os.tmpdir(), 'autoflow-i18n-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ],
});

let worker = null;
{
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !worker) {
    for (const w of ctx.serviceWorkers()) {
      try {
        const name = await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? '');
        if (/autoflow/i.test(name)) { worker = w; break; }
      } catch { /* not ours */ }
    }
    if (!worker) await new Promise((r) => setTimeout(r, 300));
  }
}
if (!worker) { console.error('the service worker never started'); await ctx.close(); process.exit(1); }
const id = new URL(worker.url()).host;
check('the service worker started', true, id);

// ---- English first, so the change is a change and not a default
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForTimeout(1200);

const en = await panel.evaluate(() => ({
  lang: document.documentElement.getAttribute('lang'),
  dir: document.documentElement.getAttribute('dir'),
  text: document.body.innerText,
}));
check('English: lang is en and dir is ltr', en.lang === 'en' && en.dir === 'ltr', `lang=${en.lang} dir=${en.dir}`);
check('English: a known string is present', /Automations|Scheduled/.test(en.text),
  JSON.stringify(en.text.slice(0, 80)));

// ---- switch the stored language to Persian, the way the options page does
await worker.evaluate(async () => {
  const cur = await chrome.storage.local.get('settings');
  const s = { ...(cur.settings ?? {}), language: 'fa' };
  await chrome.storage.local.set({ settings: s });
});

// a fresh page load is what the user gets after the change
const faPanel = await ctx.newPage();
await faPanel.goto(`chrome-extension://${id}/panel.html`);
await faPanel.waitForTimeout(1500);

const fa = await faPanel.evaluate(() => ({
  lang: document.documentElement.getAttribute('lang'),
  dir: document.documentElement.getAttribute('dir'),
  text: document.body.innerText,
  font: getComputedStyle(document.documentElement).getPropertyValue('--af-font').trim(),
}));
console.log(`\n  panel, Persian:\n    lang=${fa.lang} dir=${fa.dir}`);
console.log(`    text: ${JSON.stringify(fa.text.replace(/\s+/g, ' ').slice(0, 160))}`);

check('Persian: lang is fa', fa.lang === 'fa', `lang=${fa.lang}`);
check('Persian: dir is rtl, which is what mirrors the layout', fa.dir === 'rtl', `dir=${fa.dir}`);
check('Persian: a Persian font stack is set, so the glyphs render', fa.font.includes('Vazirmatn'), fa.font || '(none)');
check('Persian: the rendered text is actually Persian', /[\u0600-\u06FF]/.test(fa.text),
  `Persian characters found: ${/[\u0600-\u06FF]/.test(fa.text)}`);
check('Persian: no raw catalogue key leaked to the screen', !/\b(step|field|action|opt)\.[a-zA-Z]+\b/.test(fa.text),
  (fa.text.match(/\b(step|field|action|opt)\.[a-zA-Z]+\b/g) || []).slice(0, 5).join(', ') || 'none');

// THE CHECK THAT MATTERS, and the one that would have caught the English tab bar: look at the rendered
// words, not at the source. Words that are legitimately Latin are listed; anything else is a string that did
// not get translated, whatever shape it took in the code.
const ALLOWED_LATIN = new Set([
  'AutoFlow', 'CSS', 'XPath', 'JSON', 'CSV', 'DOM', 'URL', 'ms', 'px', 'id', 'name', 'label', 'aria',
  'role', 'cron', 'Alt', 'Shift', 'Ctrl', 'Tab', 'Enter', 'Esc', 'English', 'Firefox', 'Chrome',
]);
const latinWords = [...new Set((fa.text.match(/[A-Za-z][A-Za-z]{2,}/g) || []))]
  .filter((w) => !ALLOWED_LATIN.has(w));
check('Persian: no untranslated English word is rendered', latinWords.length === 0,
  latinWords.length ? `found: ${latinWords.slice(0, 15).join(', ')}` : 'none');

// the step-kind names come from a label map, so they are the interesting case
const stepText = await faPanel.evaluate(async () => {
  const sel = document.querySelector('#add-kind');
  if (!sel) return { found: false };
  return { found: true, options: [...sel.options].map((o) => o.textContent).slice(0, 10) };
});
if (stepText.found) {
  const persian = stepText.options.filter((o) => /[\u0600-\u06FF]/.test(o));
  check('the step-kind dropdown is translated', persian.length >= 5,
    `first 10: ${stepText.options.join(' | ')}`);
} else {
  check('the step-kind dropdown is translated', null, 'no #add-kind select on the first screen');
}

// ---- the options page, same language
const faOptions = await ctx.newPage();
await faOptions.goto(`chrome-extension://${id}/options.html`);
await faOptions.waitForTimeout(1500);
const opt = await faOptions.evaluate(() => {
  const sel = document.querySelector('#language');
  return {
    lang: document.documentElement.getAttribute('lang'),
    dir: document.documentElement.getAttribute('dir'),
    text: document.body.innerText,
    languages: sel ? [...sel.options].map((o) => ({ value: o.value, label: o.textContent })) : null,
    selected: sel?.value ?? null,
  };
});
console.log(`\n  options, Persian:\n    lang=${opt.lang} dir=${opt.dir}`);
console.log(`    language selector: ${JSON.stringify(opt.languages)}  selected=${opt.selected}`);

check('options: lang is fa and dir is rtl', opt.lang === 'fa' && opt.dir === 'rtl', `lang=${opt.lang} dir=${opt.dir}`);
check('options: a language selector exists', !!opt.languages, JSON.stringify(opt.languages));
check('options: it shows the stored choice as selected', opt.selected === 'fa', `selected=${opt.selected}`);
check('options: it offers English and Persian', !!opt.languages?.find((l) => l.value === 'en')
  && !!opt.languages?.find((l) => l.value === 'fa'), JSON.stringify(opt.languages?.map((l) => l.value)));
check('options: no raw key leaked', !/\b(step|field|action|opt)\.[a-zA-Z]+\b/.test(opt.text),
  (opt.text.match(/\b(step|field|action|opt)\.[a-zA-Z]+\b/g) || []).slice(0, 5).join(', ') || 'none');

// ---- and switching back to English restores it, so the change is reversible
await faOptions.selectOption('#language', 'en');
await faOptions.waitForTimeout(1200);
const back = await faOptions.evaluate(() => ({
  lang: document.documentElement.getAttribute('lang'),
  dir: document.documentElement.getAttribute('dir'),
  hasEnglish: /Settings|Appearance|Language/.test(document.body.innerText),
}));
check('switching back to English restores ltr immediately',
  back.lang === 'en' && back.dir === 'ltr' && back.hasEnglish,
  `lang=${back.lang} dir=${back.dir} english=${back.hasEnglish}`);

await ctx.close();

console.log('\n' + '='.repeat(74));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);
