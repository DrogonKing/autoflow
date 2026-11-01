#!/usr/bin/env node
/** Read the Basic tab's inputs, waiting properly for boot before clicking. */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const ROOT = '/root/autoflow';
const p = mkdtempSync(path.join(os.tmpdir(), 'af-in-'));
const ctx = await chromium.launchPersistentContext(p, {
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
const errs = [];
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
const pg = await ctx.newPage();
pg.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`.slice(0, 200)));
pg.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 200)}`); });

await pg.goto(`chrome-extension://${id}/panel.html`);
await pg.waitForLoadState('domcontentloaded');
await pg.waitForSelector('nav.tabs button', { timeout: 15000 });
await pg.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 1200));

console.log('active tab:', await pg.evaluate(() => document.querySelector('nav.tabs button.active')?.textContent));
console.log('inputs in main:', JSON.stringify(await pg.evaluate(() =>
  [...document.querySelectorAll('main input')].map((i) => ({ cls: i.className, type: i.type, ml: i.getAttribute('maxlength'), v: i.value })))));
console.log('any input at all:', JSON.stringify(await pg.evaluate(() =>
  [...document.querySelectorAll('input')].map((i) => ({ cls: i.className, ml: i.getAttribute('maxlength'), v: i.value })))));
console.log('main text head:', JSON.stringify((await pg.evaluate(() => document.querySelector('main')?.textContent ?? '')).slice(0, 120)));
console.log('errors:', JSON.stringify(errs));

await ctx.close();
process.exit(0);
