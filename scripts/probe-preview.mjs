#!/usr/bin/env node
/**
 * Why does the preview still say 09:00 after typing 08:45:52?
 *
 * The field holds the right value and the model is written on every keystroke, so either `refreshPreview` is never
 * reached, or it is reached and reads a schedule that has not been updated yet.
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

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-pv-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1100 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message.slice(0, 200)));
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 15000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const snapshot = () => panel.evaluate(() => ({
  field: document.querySelector('input.time-input')?.value ?? null,
  preview: [...document.querySelectorAll('.preview-label')].map((e) => e.textContent),
  next: [...document.querySelectorAll('.preview-next')].map((e) => e.textContent),
}));

console.log('before typing:', JSON.stringify(await snapshot()));

// instrument: is the hook present and is it reached?
console.log('hook type:', await panel.evaluate(() => typeof window.__state?.basicRefreshPreview));
console.log('state exposed on window?', await panel.evaluate(() => typeof window.__state));

await panel.click('input.time-input', { clickCount: 3 });
await panel.keyboard.press('Backspace');
// EXACTLY what pick-digits-test does: Persian digits through insertText
await panel.keyboard.insertText('۰۸:۴۵:۵۲');
await new Promise((r) => setTimeout(r, 500));
console.log('after insertText ۰۸:۴۵:۵۲:', JSON.stringify(await snapshot()));

console.log('\n--- and after inserting the same digits WITHOUT separators ---');
await panel.click('input.time-input', { clickCount: 3 });
await panel.keyboard.press('Backspace');
await panel.keyboard.insertText('۰۸۴۵۵۲');
await new Promise((r) => setTimeout(r, 500));
console.log('after insertText ۰۸۴۵۵۲:', JSON.stringify(await snapshot()));

await panel.keyboard.press('Tab');
await new Promise((r) => setTimeout(r, 900));
console.log('after Tab:', JSON.stringify(await snapshot()));

await ctx.close();
process.exit(0);