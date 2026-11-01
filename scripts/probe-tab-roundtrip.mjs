#!/usr/bin/env node
/**
 * DOES LEAVING THE BASIC TAB AND RETURNING GIVE A CLEAN FORM?
 *
 * `ui-basic-test` depends on it: section 1 adds a point to force a re-render, then leaves the tab and comes back expecting
 * one point row. It got two. The test's own comment calls this "the flow a user actually performs", so if unsaved work
 * now survives a tab switch, that is a real change in behaviour and the user should hear about it - not just the test.
 *
 * This measures the before/after without asserting, and prints which representation still holds the point.
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

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-tab-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 12 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
const id = new URL(sw.url()).host;
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 1000));

const rows = () => panel.evaluate(() => document.querySelectorAll('main .step').length);
const goto = async (re) => {
  await panel.evaluate((pattern) => {
    const b = [...document.querySelectorAll('nav button')].find((x) => new RegExp(pattern, 'i').test(x.textContent));
    b?.click();
  }, re);
  await new Promise((r) => setTimeout(r, 700));
};
const addPoint = async () => {
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => /add a point|افزودن نقطه/i.test(x.textContent));
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 800));
};

console.log('=== as opened ===');
console.log('  point rows:', await rows());

/**
 * SECTION 1 TYPES A TIME FIRST, and that is the difference from a bare add-a-point. Typing arms the auto-save and writes
 * the model, so it is reproduced here before concluding anything about the tab round trip.
 */
console.log('\n=== type a time, then Tab (what section 1 does) ===');
const box = await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(box.x, box.y);
await panel.keyboard.press('Control+a');
await panel.keyboard.type('08:45:52', { delay: 60 });
await panel.keyboard.press('Tab');
await new Promise((r) => setTimeout(r, 700));
console.log('  time field now:', await panel.evaluate(() => document.querySelector('input.time-input')?.value));
console.log('  point rows:', await rows());

console.log('\n=== add a point (this is what section 1 does) ===');
await addPoint();
console.log('  point rows:', await rows());
console.log('  time field still:', await panel.evaluate(() => document.querySelector('input.time-input')?.value));

console.log('\n=== leave to History, come back to Basic ===');
await goto('history|تاریخچه');
await goto('basic|ساده');
console.log('  point rows after the round trip:', await rows());

console.log('\n=== and what storage holds meanwhile ===');
console.log(JSON.stringify(await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => ({ id: a.id, steps: (a.steps ?? []).length }));
})));

console.log('\n=== leave, RELOAD the panel, come back ===');
await panel.reload();
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 1000));
console.log('  point rows after a reload:', await rows());

await ctx.close();
process.exit(0);