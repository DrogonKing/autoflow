#!/usr/bin/env node
/**
 * How many point rows are shown, step by step?
 *
 * The regression report is "+ adds a point -> 3" where 2 was expected. Rather than reason about it, press each control in
 * turn and print the count after every one, so the arithmetic is visible.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const ROOT = '/root/autoflow';
const p = mkdtempSync(path.join(os.tmpdir(), 'af-count-'));
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

const steps = () => pg.evaluate(() => document.querySelectorAll('main .step').length);
const openTime = () => pg.evaluate(() => document.querySelector('input.time-input')?.value);
const chips = () => pg.evaluate(() => [...document.querySelectorAll('.event-chip')].map((c) => c.textContent.trim()));
const pointsOfOpen = () => pg.evaluate(() => {
  // count the point rows that belong to the OPEN time: the ones after the time field
  return document.querySelectorAll('main .step').length;
});

console.log('open                    :', await steps(), 'steps, time', await openTime(), 'chips', JSON.stringify(await chips()));

await pg.evaluate(() => [...document.querySelectorAll('main button')].find((b) => /^\+\s*Add a point/i.test(b.textContent.trim()))?.click());
await new Promise((r) => setTimeout(r, 700));
console.log('after "+ Add a point"   :', await steps(), 'steps');

await pg.evaluate(() => [...document.querySelectorAll('main button')].find((b) => /New time/i.test(b.textContent.trim()))?.click());
await new Promise((r) => setTimeout(r, 700));
console.log('after "+ New time"      :', await steps(), 'steps, time', await openTime(), 'chips', JSON.stringify(await chips()));

await pg.evaluate(() => [...document.querySelectorAll('main button')].find((b) => /^\+\s*Add a point/i.test(b.textContent.trim()))?.click());
await new Promise((r) => setTimeout(r, 700));
console.log('after another add point :', await steps(), 'steps');

await ctx.close();
process.exit(0);
