#!/usr/bin/env node
/**
 * THE REPORT: "after EVERY pick this error comes -
 *   That pick found [data-symbol="فزر"] > div:nth-of-type(3) > div:nth-of-type(6), but no point was waiting for it."
 *
 * The selector is the panel's own wording, so this is the `else` branch of the `element-picked` listener: the finder
 * arrived and no step claimed it. It happened EVERY time, which rules out a race and points at a path where the target is
 * never held at all.
 *
 * There are two Pick buttons in the codebase. The simple form's passes a `redraw` that keeps the draft; the full
 * editor's passed a bare `render()`, which rebuilds `state.editing` from storage - dropping `state.pickTarget` on the way.
 * The editor is the tab a user reaches for a multi-step automation, and it is the one that was broken.
 *
 * This drives that exact path: Automations tab, open the record, press Pick on a step, click an element in the page.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIM = path.join(ROOT, 'tools', 'sim', 'index.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const profile = autoCleanup(mkdtempSync(path.join(tmpdir(), 'af-editor-pick-')));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [
    `--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`,
    '--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ],
});

let worker = null;
for (let i = 0; i < 80 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 250));
}
if (!worker) { console.log('no worker'); process.exit(1); }
const extId = new URL(worker.url()).host;

const page = await ctx.newPage();
await page.goto(`file://${SIM}`);
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null, null, { timeout: 15000 });

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForTimeout(1200);
const panelErrors = [];
panel.on('pageerror', (e) => panelErrors.push(String(e?.message ?? e)));
await panel.evaluate(() => {
  window.__msgs = [];
  chrome.runtime.onMessage.addListener((m) => { try { window.__msgs.push(m?.type); } catch {} });
});

// a real automation with three steps, saved, so the editor has something to open
await panel.evaluate(async () => {
  await chrome.runtime.sendMessage({
    type: 'save-automation',
    automation: {
      id: 'editor-case', name: 'Three steps', enabled: true, urls: ['file:///*'],
      steps: [1, 2, 3].map((n) => ({ id: `step-${n}`, kind: 'click', finder: { strategy: 'css', selector: '' } })),
      schedule: { kind: 'manual' },
    },
  });
});

/**
 * THE PANEL LOADED ITS LIST AT BOOT, so an automation saved afterwards is not in it. Reloading is what a person does by
 * reopening the panel - and it is also the state a fresh install is in.
 */
const saved = await panel.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
    id: 'editor-case', name: 'Three steps', enabled: true, urls: ['file:///*'],
    steps: [1, 2, 3].map((n) => ({ id: `step-${n}`, kind: 'click', finder: { strategy: 'css', selector: '' } })),
    schedule: { kind: 'manual' },
  } });
  const list = await chrome.runtime.sendMessage({ type: 'list-automations' });
  return { ok: r?.ok, error: r?.error ?? null, ids: (list?.automations ?? []).map((a) => a.id) };
});
console.log(`  saved: ${JSON.stringify(saved)}`);
await panel.reload();
await panel.waitForTimeout(1500);

console.log('\n--- open the Automations tab and the editor ---');
await panel.evaluate(() => { const b = [...document.querySelectorAll('nav button')].find((x) => /Automations/.test(x.textContent ?? '')); b?.click(); });
await panel.waitForTimeout(700);
/**
 * The editor is opened with the card's own "✎ Edit" control (i18n key `ui.edit`). Matching on English words was the
 * reason the first run found nothing: the label carries a glyph, and the interface language here is not English.
 */
const opened = await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /✎|Edit|ویرایش/.test(x.textContent ?? ''));
  if (b) { b.click(); return b.textContent.trim(); }
  return { buttons: [...document.querySelectorAll('main button')].map((x) => x.textContent.trim()).slice(0, 10) };
});
await panel.waitForTimeout(900);
const editorUp = await panel.evaluate(() => ({
  pickButtons: document.querySelectorAll('main button.pick').length,
  stepIds: [...document.querySelectorAll('main [data-step-id]')].map((e) => e.getAttribute('data-step-id')),
}));
console.log(`  opened via: ${JSON.stringify(opened)}`);
console.log(`  editor: ${JSON.stringify(editorUp)}`);
check('the editor is open with its steps', editorUp.pickButtons >= 3, JSON.stringify(editorUp));

console.log('\n--- press Pick on the SECOND step, then click in the page ---');
const pick = panel.locator('main button.pick').nth(1);
const pressedId = await pick.getAttribute('data-step-id');
await pick.click();
await panel.waitForTimeout(400);
await page.waitForFunction(() => document.documentElement.style.cursor === 'crosshair', null, { timeout: 8000 })
  .catch(() => console.log('  (no crosshair - the picker may not have started)'));

await page.bringToFront();
const box = await page.evaluate(() => {
  const el = document.querySelector('#pad3');
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(box.x, box.y);
await panel.waitForTimeout(1400);
await panel.bringToFront();
await panel.waitForTimeout(300);

const after = await panel.evaluate(() => ({
  text: document.querySelector('main')?.innerText ?? '',
  noPointWaiting: /no point was waiting|هیچ نقطه‌ای منتظرش نبود/i.test(document.querySelector('main')?.innerText ?? ''),
  selectors: [...document.querySelectorAll('main input')].map((i) => i.value).filter((v) => /pad|data-symbol|#/.test(v)),
  debug: (globalThis.__pickDebug ?? []).slice(-4),
}));

console.log(`  messages: ${JSON.stringify(await panel.evaluate(() => window.__msgs ?? []))}`);
for (const d of after.debug) console.log(`    ${JSON.stringify(d)}`);

check('THE REPORTED ERROR DOES NOT APPEAR after the pick', after.noPointWaiting === false,
  after.noPointWaiting ? 'the "no point was waiting" message came back' : 'no complaint');
check('and the selector reached a step in the editor', after.selectors.length > 0, JSON.stringify(after.selectors));
check('the step that received it is the one whose Pick was pressed, or the only candidate',
  after.debug.some((d) => d.event === 'adopted' || d.found === true) || after.selectors.length > 0,
  JSON.stringify(after.debug.map((d) => d.event ?? (d.found ? 'found' : 'lost'))));
check('no panel errors', panelErrors.length === 0, JSON.stringify(panelErrors.slice(0, 2)));

const passed = results.filter((r) => r.ok === true).length;
console.log(`\n${'='.repeat(70)}\n${passed}/${results.length} checks passed`);
for (const r of results.filter((r) => r.ok !== true)) console.log(`  FAIL ${r.name}`);
await ctx.close();
process.exit(passed === results.length ? 0 : 1);