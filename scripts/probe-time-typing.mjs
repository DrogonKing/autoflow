#!/usr/bin/env node
/**
 * SETTING A TIME MUST NOT BE INTERRUPTED.
 *
 * Reported: "وقتی دارم ساعت تنظیم میکنم بخاطر اوتسیو هی منو از تنظیم ساعت میندازه بیرون و باید به سختی و سریع ساعت رو
 * تنظیم کنم" - while setting the time, the auto-save keeps kicking me out of the field, so it has to be done quickly.
 *
 * So this measures exactly that: does focus stay, does the caret stay, and does the value survive, while the auto-save
 * fires underneath. Each step prints what it observed rather than asserting one guess about the cause.
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

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-time-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const id = new URL(sw.url()).host;
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message.slice(0, 180)));
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

/**
 * The state of the time field: value, focus, and caret. Focus is the fact the report is about - "it kicks me out" - and
 * the caret matters because it is what makes continued typing land in the right place.
 */
const field = () => panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  if (!el) return { present: false };
  return {
    present: true,
    value: el.value,
    focused: document.activeElement === el,
    activeIs: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 20) : null,
    caret: (() => { try { return el.selectionStart; } catch { return null; } })(),
    // a fresh element has no data-set marker; tagging on render lets us SEE a replacement
    mark: el.dataset.probeMark ?? null,
  };
});
const markField = () => panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  if (el) el.dataset.probeMark = String(Date.now());
  return el?.dataset.probeMark ?? null;
});

console.log('\n=== 1. type a time and DO NOT leave the field; does it stay put? ===');
const box = await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(box.x, box.y);
await panel.keyboard.press('Control+A');
await panel.keyboard.type('13:50:01.500', { delay: 40 });
console.log('  right after typing :', JSON.stringify(await field()));
const mark = await markField();
console.log('  marked element     :', mark);

for (const wait of [800, 1600, 2600]) {
  await new Promise((r) => setTimeout(r, wait === 800 ? 800 : 800));
  const f = await field();
  console.log(`  after ~${wait}ms      : focused=${f.focused} value=${f.value} sameElement=${f.mark === mark} activeIs=${f.activeIs}`);
}

console.log('\n=== 2. now CLICK the same field again and keep typing (does the caret survive?) ===');
await panel.mouse.click(box.x, box.y);
await new Promise((r) => setTimeout(r, 300));
console.log('  after re-click     :', JSON.stringify(await field()));
await panel.keyboard.press('End');
await panel.keyboard.type('7', { delay: 40 });
await new Promise((r) => setTimeout(r, 1600));
console.log('  after typing "7"   :', JSON.stringify(await field()));

console.log('\n=== 3. does a re-render replace the element? (that is what loses focus) ===');
const before = await panel.evaluate(() => document.querySelectorAll('input.time-input').length);
await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  if (el) el.dataset.probeTag = 'original';
});
// force the auto-save to fire by making an edit through the form's own path
await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /Add a point|افزودن نقطه/.test(x.textContent));
  b?.click();
});
await new Promise((r) => setTimeout(r, 2600));
const after = await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  return { count: document.querySelectorAll('input.time-input').length, tag: el?.dataset.probeTag ?? null, focused: document.activeElement === el, value: el?.value };
});
console.log('  before/after fields :', before, '->', JSON.stringify(after));
console.log('  element replaced    :', after.tag === null ? 'YES (the tag is gone)' : 'no');

await ctx.close();
process.exit(0);