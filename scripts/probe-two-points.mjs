#!/usr/bin/env node
/**
 * WHY DOES THE FORM OPEN WITH TWO POINT ROWS?
 *
 * `ui-basic-test` asserts "it starts with one click point" and got 2, and `main .step` is its counter. Two rows would mean
 * two steps in the first time - so either the draft seeds two, or the events layer adds one on top of the draft.
 *
 * This prints the model and the DOM together, so the answer is read rather than inferred.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-two-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 12 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
const id = new URL(sw.url()).host;
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message.slice(0, 200)));
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 1200));

const snap = async (label) => {
  const s = await panel.evaluate(() => ({
    steps: document.querySelectorAll('main .step').length,
    stepClasses: [...document.querySelectorAll('main .step')].map((e) => e.className),
    eventChips: [...document.querySelectorAll('.event-chip')].length,
    innerSteps: document.querySelectorAll('main .step .step').length,
    allWithStepClass: document.querySelectorAll('.step').length,
    stepIds: [...document.querySelectorAll('main .step')].map((e) => e.dataset.stepId ?? e.dataset.eventId ?? '(none)'),
  }));
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(s, null, 1));
  return s;
};

await snap('as opened');

console.log('\n=== and the stored automations at boot ===');
console.log(JSON.stringify(await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return {
    automations: (all.automations ?? []).map((a) => ({ id: a.id, steps: (a.steps ?? []).length })),
    keys: Object.keys(all),
  };
}), null, 1));

console.log('\n=== after ONE "Add a point" click ===');
const box = await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /Add a point/.test(x.textContent));
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(box.x, box.y);
await new Promise((r) => setTimeout(r, 1200));
await snap('after add');

await ctx.close();
process.exit(0);