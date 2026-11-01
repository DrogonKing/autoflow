#!/usr/bin/env node
/** Call basicView's path directly in the page and surface the throw, if there is one. */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-dbg2-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${path.join(ROOT, 'dist')}`, `--load-extension=${path.join(ROOT, 'dist')}`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;
const panel = await ctx.newPage();

// catch anything the page throws, BEFORE it is swallowed
const errs = [];
panel.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`.slice(0, 300)));
panel.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text().slice(0, 300)}`); });

await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 500));
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));
console.log('before New time, main length:', await panel.evaluate(() => document.querySelector('main')?.innerHTML?.length ?? -1));
// press the new-time button and capture what breaks
await panel.evaluate(() => {
  [...document.querySelectorAll('button')].find((b) => /New time|زمان جدید/.test(b.textContent))?.click();
});
await new Promise((r) => setTimeout(r, 900));

console.log('main body HTML length:', await panel.evaluate(() => document.querySelector('main')?.innerHTML?.length ?? -1));
console.log('main body text:', JSON.stringify(await panel.evaluate(() => document.querySelector('main')?.textContent?.slice(0, 200) ?? '')));
console.log('root children:', await panel.evaluate(() => document.getElementById('root')?.children?.length ?? -1));
console.log('\npage errors:');
for (const e of errs) console.log('  ', e);
if (!errs.length) console.log('   (none surfaced)');

await ctx.close();
process.exit(0);
