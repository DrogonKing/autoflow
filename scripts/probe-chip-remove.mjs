#!/usr/bin/env node
/** Why does removing the ACTIVE chip do nothing, while removing another one works? */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-act-')));
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

// two times
for (let i = 0; i < 2; i += 1) {
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => /New time/.test(x.textContent));
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 600));
}

const layout = await panel.evaluate(() => [...document.querySelectorAll('.event-chip')].map((c, i) => {
  const open = c.querySelector('.event-chip-open');
  const remove = c.querySelector('.event-chip-remove');
  const cr = c.getBoundingClientRect();
  const rr = remove?.getBoundingClientRect();
  return {
    i,
    chip: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
    active: c.classList.contains('active'),
    remove: rr ? { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) } : null,
    // what is actually at the centre of the remove button?
    hitAtRemoveCentre: rr ? (() => {
      const el = document.elementFromPoint(rr.x + rr.width / 2, rr.y + rr.height / 2);
      return el ? `${el.tagName}.${el.className}` : 'nothing';
    })() : 'no remove button',
    chipsText: c.textContent.trim(),
    openText: open?.textContent?.trim() ?? null,
  };
}));
console.log('layout:', JSON.stringify(layout, null, 1));

console.log('\n--- clicking the remove of chip 0 (the ACTIVE one) ---');
const box = await panel.evaluate(() => {
  const b = document.querySelectorAll('.event-chip-remove')[0];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
console.log('  box:', JSON.stringify(box));
await panel.mouse.click(box.x, box.y);
await new Promise((r) => setTimeout(r, 900));
console.log('  chips after:', JSON.stringify(await panel.evaluate(() =>
  [...document.querySelectorAll('.event-chip')].map((c) => c.textContent.trim()))));

await ctx.close();
process.exit(0);