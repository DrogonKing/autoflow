#!/usr/bin/env node
/** Is the focus key actually on the element, and is it restored? Print the DOM, not a guess. */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-fk-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 10 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
const id = new URL(sw.url()).host;
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

console.log('=== is the attribute present? ===');
console.log(JSON.stringify(await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  return {
    found: Boolean(el),
    focusKeyAttr: el?.getAttribute('data-focus-key') ?? null,
    dataset: el ? JSON.stringify(el.dataset) : null,
    outer: el ? el.outerHTML.slice(0, 200) : null,
  };
}), null, 1));

console.log('\n=== capture/restore in isolation: does the helper even run? ===');
console.log(JSON.stringify(await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  el.focus();
  el.setSelectionRange(3, 3);
  const key = el.dataset.focusKey;
  return { focused: document.activeElement === el, key, caret: el.selectionStart };
}), null, 1));

console.log('\n=== focus the field, add a point with the MOUSE, then look ===');
const box = await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(box.x, box.y);
await panel.keyboard.press('Control+A');
await panel.keyboard.type('10:32:33.250', { delay: 40 });
console.log('  before add:', JSON.stringify(await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  return { value: el.value, focused: document.activeElement === el, key: el.dataset.focusKey };
})));
const addBox = await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /Add a point|افزودن نقطه/.test(x.textContent));
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(addBox.x, addBox.y);
await new Promise((r) => setTimeout(r, 1200));
console.log('  focus log :', JSON.stringify(await panel.evaluate(() => (window.__focusLog ?? []).slice(-8)), null, 0));
console.log('  after add :', JSON.stringify(await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  return {
    value: el.value,
    focused: document.activeElement === el,
    activeTag: document.activeElement?.tagName,
    activeKey: document.activeElement?.dataset?.focusKey ?? null,
    key: el.dataset.focusKey,
  };
})));

await ctx.close();
process.exit(0);