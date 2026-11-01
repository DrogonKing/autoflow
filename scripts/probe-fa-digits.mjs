#!/usr/bin/env node
/**
 * Persian digits work in one path and not the other. Determine which step loses them, using the panel's own functions
 * rather than a re-implementation.
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

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-fa-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message.slice(0, 160)));
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 15000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const snap = () => panel.evaluate(() => ({
  field: document.querySelector('input.time-input')?.value ?? null,
  preview: document.querySelector('.preview-label')?.textContent ?? null,
}));

// the exact sequence pick-digits-test uses
await panel.click('input.time-input', { clickCount: 3 });
await panel.keyboard.press('Backspace');
console.log('after clearing        :', JSON.stringify(await snap()));

await panel.keyboard.insertText('۰۸:۴۵:۵۲');
await new Promise((r) => setTimeout(r, 400));
console.log('after insertText (fa) :', JSON.stringify(await snap()));

await panel.keyboard.press('Tab');
await new Promise((r) => setTimeout(r, 800));
console.log('after Tab             :', JSON.stringify(await snap()));

console.log('\n--- now the same value typed one character at a time ---');
await panel.click('input.time-input', { clickCount: 3 });
await panel.keyboard.press('Backspace');
await new Promise((r) => setTimeout(r, 200));
for (const ch of '۰۸:۴۵:۵۲') {
  await panel.keyboard.type(ch);
  await new Promise((r) => setTimeout(r, 60));
}
console.log('after per-char typing :', JSON.stringify(await snap()));

console.log('\n--- and what the panel computes from each shape ---');
const calc = await panel.evaluate(async () => {
  const mod = await import(chrome.runtime.getURL('panel.js')).catch(() => null);
  return { imported: Boolean(mod) };
});
console.log('  (module import from the page is not available;', JSON.stringify(calc), ')');

await ctx.close();
process.exit(0);