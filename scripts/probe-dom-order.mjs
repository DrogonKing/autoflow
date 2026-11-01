#!/usr/bin/env node
/** What is in the DOM, in order, so the button-index confusion is settled by measurement. */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const ROOT = '/root/autoflow';
const p = mkdtempSync(path.join(os.tmpdir(), 'af-order-'));
const ctx = await chromium.launchPersistentContext(p, {
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
const pg = await ctx.newPage();
await pg.goto(`chrome-extension://${id}/panel.html`);
await pg.waitForLoadState('domcontentloaded');
await pg.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

console.log('steps at open          :', await pg.evaluate(() => document.querySelectorAll('main .step').length));
console.log('main buttons, DOM order:');
for (const b of await pg.evaluate(() => [...document.querySelectorAll('main button')].map((x, i) => ({ i, t: x.textContent.trim(), c: x.className })))) {
  console.log(`   ${String(b.i).padStart(2)}  ${JSON.stringify(b.t).padEnd(22)} ${b.c}`);
}
console.log('labels                 :', JSON.stringify(await pg.evaluate(() => [...document.querySelectorAll('main label')].map((l) => l.textContent.trim()))));

await ctx.close();
process.exit(0);
