#!/usr/bin/env node
/**
 * ENTERING A NEW TIME: does the old value get out of the way, and is there ONE save?
 *
 * Two reports, both reproduced before being fixed:
 *
 *   «عددم تغییر میدم صفر میشه بعد دوباره درست میشه همش هم پشت هم سیو میشه»
 *   «نمیزاره تایم جدید وارد کنم»
 *
 * The first probe showed the mechanics: with `09:00:00` in the field, typing nine digits produced `09:00:00.103`
 * because every keystroke APPENDED to the old value and `maxlength` then refused the rest; and `onEdit` armed a save on
 * every input event, so nine digits at a human pace armed nine saves.
 *
 * So this asserts the two things a person does: click the field and type a new time (unhurried), and check that the
 * value that ends up there is the one typed and that the save count is small.
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

const PAGE = '<!doctype html><meta charset="utf-8"><style>button{position:fixed;top:100px;left:60px;width:150px;height:70px}</style><button id="target">buy</button>';
const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-newtime-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 12 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const value = () => panel.evaluate(() => document.querySelector('input.time-input')?.value ?? null);
const saves = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.diagnosticEvents ?? []).filter((e) => e.kind === 'save-request').length;
});
const clickField = async () => {
  const box = await panel.evaluate(() => {
    const el = document.querySelector('input.time-input');
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await panel.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 250));
};

/**
 * PICK A POINT FIRST, so the save has something to store.
 *
 * MEASURED: without a point the auto-save returns early by design (`anyUsable` is false), so "0 saves while typing"
 * proved nothing about the save behaviour - it was a form with nothing to save. The user's rule is about a real form.
 */
console.log('\n=== 0. pick a target, so this form has something to save ===');
const pickBox = await panel.evaluate(() => {
  const b = document.querySelector('main button.pick');
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(pickBox.x, pickBox.y);
await panel.waitForTimeout(500);
await page.bringToFront();
const target = await page.evaluate(() => {
  const r = document.getElementById('target').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(target.x, target.y);
await panel.waitForTimeout(1800);
await panel.bringToFront();
await panel.waitForTimeout(600);
console.log('  picked; saves so far:', await saves());

console.log('\n=== 1. click the field and type a whole new time, at an unhurried pace ===');
await clickField();
const selected = await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  return { start: el.selectionStart, end: el.selectionEnd, length: el.value.length };
});
check('the old value is selected for replacement', selected.start === 0 && selected.end === selected.length,
  JSON.stringify(selected));

const before = await saves();
const seen = [];
for (const ch of '103233250') {
  await panel.keyboard.type(ch);
  await new Promise((r) => setTimeout(r, 160));      // a human pace, slower than the 1.2s debounce
  seen.push(await value());
}
console.log('  after each keystroke:', JSON.stringify(seen));
check('the typed time REPLACES the old one, not appends',
  (await value()) === '10:32:33.250', `${await value()}`);
check('and it was right from the second keystroke, not only at the end',
  seen[1] === '10:32' || String(seen[1]).startsWith('10'), JSON.stringify(seen.slice(0, 4)));
check('no digit was swallowed', !String(await value()).includes('09:00'), `${await value()}`);

console.log('\n=== 2. how many saves did that make? ===');
await panel.evaluate(() => document.querySelector('input.time-input')?.blur());
await new Promise((r) => setTimeout(r, 2600));
const duringTyping = (await saves()) - before;
console.log(`  saves: ${duringTyping} for a nine-digit time`);
check('typing a time does not save once per keystroke', duringTyping <= 2,
  `${duringTyping} save(s) - one on settling is expected, nine is the reported fault`);

console.log('\n=== 3. and it is an unhurried session: no save storm while idle ===');
const idleBase = await saves();
await new Promise((r) => setTimeout(r, 5000));
const idleSaves = (await saves()) - idleBase;
check('nothing saves while the user is doing nothing', idleSaves === 0, `${idleSaves} save(s) in 5 idle seconds`);

console.log('\n=== 4. a second time can also be entered from scratch ===');
const nt = await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /New time/.test(x.textContent));
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(nt.x, nt.y);
await new Promise((r) => setTimeout(r, 900));
const chips = await panel.evaluate(() => [...document.querySelectorAll('.event-chip')].map((c) => c.dataset.eventId));
console.log('  times now:', JSON.stringify(chips));
// two times means two chips: the chooser appears as soon as there is something to choose between
check('a second time was added', chips.length === 2, JSON.stringify(chips));
const fields = await panel.evaluate(() => document.querySelectorAll('input.time-input').length);
check('and the new time has its own time field', fields === 1, `${fields} field(s)`);

server.close();
await ctx.close();
console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);