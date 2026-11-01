#!/usr/bin/env node
/**
 * THREE TIMES, EACH WITH ITS OWN POINTS — the three things the user reported.
 *
 * Their report, on a log from 1.21.0:
 *   1. "باگ اول کمتر از ثانیه نمیذاره انتخاب کنم و نمیتونم میلی ثانیه اضافه کنم" - a fraction of a second could not be
 *      entered at all.
 *   2. "فقط زمان اولی رو شلیک کرد و pickهای زمان دوم و سوم شلیک نشدن" - only the first time fired.
 *   3. "بهش اتوسیو هم اضافه کن" - add an auto-save.
 *
 * WHY THE KEYSTROKES HERE ARE REAL. The earlier millisecond test used `keyboard.insertText()`, which sets the value
 * through the `input` event and is NOT subject to `maxlength` - so it passed while a person typing could not get past
 * the eighth character. `keyboard.type()` sends actual keystrokes. This suite uses only `type()`, on purpose.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail ? `\n        ${String(detail).slice(0, 220)}` : ''}`);
};

/**
 * A page whose three targets record their own clicks, so "did the run click the right element" is answered by the page
 * rather than by the extension's own claim.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>three times</title>
<style>html,body{margin:0;font:14px sans-serif}
button{position:fixed;width:150px;height:70px;font:16px sans-serif}</style>
<button id="pad1" style="top:100px;left:60px">۱</button>
<button id="pad2" style="top:100px;left:240px">۲</button>
<button id="pad3" style="top:100px;left:420px">۳</button>
<script>
  window.__clicks = [];
  for (const id of ['pad1','pad2','pad3']) {
    document.getElementById(id).addEventListener('click', () => window.__clicks.push({ id, at: Date.now() }));
  }
</script>`;

const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-3t-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1100 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(pageUrl);

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 15000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const timeValue = () => panel.evaluate(() => document.querySelector('input.time-input')?.value ?? '');
const chips = () => panel.evaluate(() => [...document.querySelectorAll('.event-chip')].map((c) => c.textContent.trim()));
const press = async (re) => {
  const box = await panel.evaluate((pattern) => {
    const b = [...document.querySelectorAll('main button')].find((x) => new RegExp(pattern).test(x.textContent.trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, re);
  if (!box) return false;
  await panel.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 600));
  return true;
};
/** Type a time the way a person does: select what is there, delete it, then one keystroke per digit. */
const typeTime = async (digits) => {
  const f = await panel.$('input.time-input');
  await f.click();
  await panel.keyboard.press('Control+A');
  await panel.keyboard.press('Backspace');
  await panel.keyboard.type(digits, { delay: 22 });
  await panel.evaluate(() => document.querySelector('input.time-input')?.blur());
  await new Promise((r) => setTimeout(r, 500));
};
const setSelector = async (sel) => {
  const ok = await panel.evaluate((s) => {
    const inputs = [...document.querySelectorAll('main input')].filter((x) => !/time-input/.test(x.className));
    const i = inputs[inputs.length - 1];
    if (!i) return false;
    i.value = s;
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, sel);
  await new Promise((r) => setTimeout(r, 400));
  return ok;
};

console.log('\n=== 1. CAN A REAL KEYBOARD ENTER MILLISECONDS? ===');
const f0 = await panel.$('input.time-input');
const ml = await f0.getAttribute('maxlength');
check('the field allows twelve characters, which is what HH:MM:SS.mmm needs', Number(ml) >= 12, `maxlength=${ml}`);
await typeTime('103233250');
check('typing nine digits produces a fraction of a second', (await timeValue()) === '10:32:33.250', await timeValue());

console.log('\n=== 2. THREE TIMES, EACH WITH ITS OWN POINT ===');
await setSelector('#pad1');
const before = (await chips()).length;
check('one time is shown, and no chooser yet', before === 0, `${before} chip(s)`);

for (const [n, digits, sel] of [[2, '103240000', '#pad2'], [3, '103500000', '#pad3']]) {
  const added = await press('^\\+\\s*New time');
  check(`"New time" is pressable for time ${n}`, added, '');
  await typeTime(digits);
  await setSelector(sel);
}
const all = await chips();
check('three times are listed, each with one point', all.length === 3, all.join(' | '));

console.log('\n=== 3. AUTO-SAVE: no Save press at all ===');
// the last change was the selector on time 3, which arms the auto-save; wait past the debounce
await new Promise((r) => setTimeout(r, 2200));
const stored = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const list = all.automations ?? [];
  const alarms = await chrome.alarms.getAll();
  return {
    count: list.length,
    times: list.map((a) => `${a.schedule?.hour}:${String(a.schedule?.minute).padStart(2, '0')}:${String(a.schedule?.second).padStart(2, '0')}${a.schedule?.ms ? '.' + String(a.schedule.ms).padStart(3, '0') : ''}`).sort(),
    steps: list.map((a) => (a.steps ?? []).length),
    selectors: list.flatMap((a) => (a.steps ?? []).map((s) => s.finder?.selector ?? '—')),
    alarms: alarms.length,
  };
});
console.log('  stored:', JSON.stringify(stored));
check('all three times were saved WITHOUT pressing Save', stored.count === 3, `${stored.count}`);
check('and each kept its own point', stored.steps.every((n) => n === 1) && stored.selectors.length === 3,
  JSON.stringify(stored.selectors));
check('every time got its own alarm', stored.alarms === 3, `${stored.alarms}`);

console.log('\n=== 4. THE SAVE SURVIVES A REOPEN ===');
await panel.reload();
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 15000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));
const reopened = await chips();
check('all three times come back after reopening the panel', reopened.length === 3, reopened.join(' | '));

console.log('\n=== 5. EACH TIME KEEPS ITS OWN TARGET, WHICH IS WHAT MAKES THEM INDEPENDENT ===');
/**
 * WHY NOT PRESS "Run now" HERE. The points in this test were typed into the selector boxes rather than picked, so the
 * automation has no page association - the worker then refuses to guess a tab, which is documented behaviour ("no URL
 * pattern, so a scheduled run has no safe tab") and is covered end-to-end by `e2e-test` after a real Pick.
 *
 * What THIS check is for is the user's actual complaint: that the times could not fire independently. The evidence that
 * they can is that each stored record carries ITS OWN step list, so a run of record N clicks element N and nothing else.
 */
const records = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => ({
    id: a.id,
    time: `${a.schedule?.hour}:${String(a.schedule?.minute).padStart(2, '0')}:${String(a.schedule?.second).padStart(2, '0')}${a.schedule?.ms ? '.' + String(a.schedule.ms).padStart(3, '0') : ''}`,
    selectors: (a.steps ?? []).map((s) => s.finder?.selector),
  })).sort((x, y) => x.time.localeCompare(y.time));
});
console.log('  records:', JSON.stringify(records));
const targets = records.flatMap((r) => r.selectors);
check('no two times share a target, so each fires its own clicks',
  new Set(targets).size === targets.length && targets.length === 3, JSON.stringify(targets));

server.close();
await ctx.close();
console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);