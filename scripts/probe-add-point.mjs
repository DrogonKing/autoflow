#!/usr/bin/env node
/**
 * WHY DOES "+ ADD A POINT" DO NOTHING after a reload + tab switch?
 *
 * `ui-basic-test` section 2: reload the panel, click History, click Basic, blur the time field, then click "+ Add a
 * point" and expect two rows. It got one - so the click did not reach the button. This runs that exact sequence and
 * reports, at each step, what is where: the button's position before the click, the position again at click time, what is
 * under the pointer, and the row count after.
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

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-addp-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1400, height: 900 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 12 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
const id = new URL(sw.url()).host;
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message.slice(0, 200)));
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav button', { timeout: 20000 });
await panel.waitForTimeout(600);

const rows = () => panel.evaluate(() => document.querySelectorAll('main .step').length);
const where = () => panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /^\+?\s*(add a point|افزودن نقطه)/i.test(x.textContent.trim()));
  const out = { found: Boolean(b), rows: document.querySelectorAll('main .step').length, tab: null };
  if (b) {
    const r = b.getBoundingClientRect();
    out.rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    out.centre = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    out.atCentre = (() => {
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return el ? `${el.tagName}.${String(el.className).split(' ')[0]}:${(el.textContent ?? '').trim().slice(0, 20)}` : 'nothing';
    })();
    out.disabled = b.disabled;
  }
  const tabBtn = [...document.querySelectorAll('nav button')].find((x) => x.getAttribute('aria-current') === 'page' || x.classList.contains('active'));
  out.activeTab = tabBtn?.textContent?.trim() ?? null;
  return out;
});

console.log('=== as loaded ===');
console.log(JSON.stringify(await where(), null, 1));
console.log('  rows:', await rows());

console.log('\n=== click History, then Basic ===');
await panel.evaluate(() => {
  const b = [...document.querySelectorAll('nav button')].find((x) => /history|تاریخچه/i.test(x.textContent));
  b?.click();
});
await panel.waitForTimeout(500);
console.log('  after History:', JSON.stringify(await where()));
await panel.evaluate(() => {
  const b = [...document.querySelectorAll('nav button')].find((x) => /basic|ساده/i.test(x.textContent));
  b?.click();
});
await panel.waitForTimeout(700);
console.log('  after Basic  :', JSON.stringify(await where()));

console.log('\n=== blur the time field (as the test does) ===');
await panel.evaluate(() => document.querySelector('input.time-input')?.blur());
await panel.waitForTimeout(500);
console.log('  after blur   :', JSON.stringify(await where()));

console.log('\n=== type a time first (the test does this before clicking) ===');
const tb = await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
console.log('  time field found:', Boolean(tb));
if (tb) {
  await panel.mouse.click(tb.x, tb.y);
  await panel.keyboard.press('Control+a');
  await panel.keyboard.type('09:15:30', { delay: 60 });
  await panel.waitForTimeout(300);
  console.log('  value after typing:', await panel.evaluate(() => document.querySelector('input.time-input')?.value));
  console.log('  rows after typing:', await rows());
  await panel.evaluate(() => document.querySelector('input.time-input')?.blur());
  await panel.waitForTimeout(600);
  console.log('  rows after blur  :', await rows());
}

console.log('\n=== click the button at the position measured NOW ===');
const w = await where();
if (w.centre) {
  console.log(`  clicking ${JSON.stringify(w.centre)}, element there: ${w.atCentre}`);
  await panel.mouse.click(w.centre.x, w.centre.y);
  await panel.waitForTimeout(1000);
  console.log('  rows after click:', await rows());
  console.log('  state now:', JSON.stringify(await where()));
} else {
  console.log('  BUTTON NOT FOUND');
}

console.log('\n=== and by direct DOM click, for comparison ===');
await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /^\+?\s*(add a point|افزودن نقطه)/i.test(x.textContent.trim()));
  b?.click();
});
await panel.waitForTimeout(1000);
console.log('  rows after a direct click:', await rows());

await ctx.close();
process.exit(0);