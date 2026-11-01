#!/usr/bin/env node
/** Why is the Basic tab not opening? Look at the nav and what a click actually does. */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-dbg-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${path.join(ROOT, 'dist')}`, `--load-extension=${path.join(ROOT, 'dist')}`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 800));

console.log('nav buttons:', JSON.stringify(await panel.evaluate(() =>
  [...document.querySelectorAll('nav.tabs button')].map((b) => ({ text: b.textContent, cls: b.className })))));

console.log('\nactive tab:', await panel.evaluate(() => document.querySelector('nav.tabs button.active')?.textContent));

console.log('\n--- click the first nav button ---');
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));
console.log('active now:', await panel.evaluate(() => document.querySelector('nav.tabs button.active')?.textContent));
console.log('time inputs:', await panel.evaluate(() => [...document.querySelectorAll('input.time-input')].length));
console.log('labels:', JSON.stringify(await panel.evaluate(() => [...document.querySelectorAll('label')].map((l) => l.textContent.trim()).slice(0, 10))));
console.log('any error text:', await panel.evaluate(() => [...document.querySelectorAll('.warn')].map((e) => e.textContent.trim().slice(0, 90))));
const errs = [];
panel.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
await new Promise((r) => setTimeout(r, 300));
console.log('page errors:', JSON.stringify(errs));

await ctx.close();
process.exit(0);
