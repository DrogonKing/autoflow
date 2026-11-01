#!/usr/bin/env node
/**
 * CAN A REAL KEYBOARD ENTER MILLISECONDS?
 *
 * The user reported "باگ اول کمتر از ثانیه نمیذاره انتخاب کنم و نمیتونم میلی ثانیه اضافه کنم" - they cannot enter a
 * fraction of a second. My own test passed, so the difference must be in HOW the value is entered.
 *
 * `keyboard.insertText()` sets the value through the input event and bypasses `maxlength`; `keyboard.type()` sends real
 * keystrokes and is subject to it. That is the same class as `element.click()` bypassing hit-testing, which this project
 * has been caught by before.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const ROOT = '/root/autoflow';
const p = mkdtempSync(path.join(os.tmpdir(), 'af-ml-'));
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

const val = () => pg.evaluate(() => document.querySelector('input.time-input')?.value ?? '');
const f = await pg.$('input.time-input');
console.log('maxlength attribute :', JSON.stringify(await f.getAttribute('maxlength')));

await f.click();
console.log('\n--- typing 135001500 (nine digits, one keystroke at a time) ---');
await pg.keyboard.type('135001500', { delay: 25 });
console.log('after typing        :', JSON.stringify(await val()));

await pg.evaluate(() => document.querySelector('input.time-input')?.blur());
await new Promise((r) => setTimeout(r, 500));
console.log('after blur          :', JSON.stringify(await val()));
console.log('expected            : "13:50:01.500"');

// re-query: the blur above re-rendered the form, so the earlier handle is detached
const f2 = await pg.$('input.time-input');
await f2.click();
await pg.keyboard.press('Control+A');
console.log('\n--- insertText, the way tests have done it (bypasses maxlength) ---');
await pg.keyboard.insertText('135001500');
console.log('after insertText    :', JSON.stringify(await val()));

// and the real thing: clear it, then type the nine digits one keystroke at a time
await pg.evaluate(() => document.querySelector('input.time-input')?.blur());
await new Promise((r) => setTimeout(r, 400));
const f3 = await pg.$('input.time-input');
await f3.click();
await pg.keyboard.press('Control+A');
await pg.keyboard.press('Backspace');
console.log('\n--- cleared, then typed for real ---');
await pg.keyboard.type('135001500', { delay: 25 });
await pg.evaluate(() => document.querySelector('input.time-input')?.blur());
await new Promise((r) => setTimeout(r, 500));
console.log('after real typing   :', JSON.stringify(await val()));
console.log('expected            : "13:50:01.500"');

await ctx.close();
process.exit(0);
