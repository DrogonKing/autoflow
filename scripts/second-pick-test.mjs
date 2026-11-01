#!/usr/bin/env node
/**
 * THE SECOND PICK DISAPPEARS AND THE FORM SAYS "saved".
 *
 * Reported: "چرا وقتی pick دوم رو میزنم و تارگت رو انتخاب میکنم کلا pick دوم حذف میشه و مینویسه saved" - after the
 * second pick the second point is deleted and it says saved.
 *
 * The suspicion is my own guard: after a save, the rows are re-seeded from storage when
 * `usable.length === basicEvents.length`. That compares the number of TIMES, not the number of POINTS - so one time
 * with two points and one time with one point compare equal, the rows are rebuilt from the record that only holds the
 * first point, and the second one vanishes.
 *
 * This reproduces it with a real Pick on a real page, which is how the user hit it.
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
  console.log(`  ${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail ? `\n        ${String(detail).slice(0, 240)}` : ''}`);
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>two points</title>
<style>html,body{margin:0;font:14px sans-serif}
button{position:fixed;width:170px;height:80px;font:16px sans-serif}</style>
<button id="first" style="top:120px;left:80px">اول</button>
<button id="second" style="top:120px;left:320px">دوم</button>
<script>window.__clicks=[];for(const i of ['first','second']){document.getElementById(i).addEventListener('click',()=>window.__clicks.push(i));}</script>`;

const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-pick2-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
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

const pointRows = () => panel.evaluate(() => document.querySelectorAll('main .step').length);
const selectors = () => panel.evaluate(() => [...document.querySelectorAll('main input')]
  .filter((x) => /grow mono/.test(x.className) && !/time-input/.test(x.className)).map((x) => x.value));
const storedSteps = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => ({ id: a.id, steps: (a.steps ?? []).map((s) => s.finder) }));
});
const pickAt = async (index, targetId) => {
  // index = which Pick button (0-based); press it, then click the element on the page
  const box = await panel.evaluate((i) => {
    const b = [...document.querySelectorAll('main button.pick')][i];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, index);
  if (!box) return false;
  await panel.mouse.click(box.x, box.y);
  await panel.waitForTimeout(500);
  await page.bringToFront();
  const t = await page.evaluate((tid) => {
    const el = document.getElementById(tid);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, targetId);
  await page.mouse.click(t.x, t.y);
  await panel.waitForTimeout(1800);
  await panel.bringToFront();
  await panel.waitForTimeout(300);
  return true;
};

console.log('\n=== add a second point, then pick BOTH ===');
const addBox = await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /^\+\s*Add a point/i.test(x.textContent.trim()));
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(addBox.x, addBox.y);
await panel.waitForTimeout(700);
check('there are now two points', (await pointRows()) === 2, `${await pointRows()}`);

console.log('\n--- pick #1 ---');
await pickAt(0, 'first');
console.log('  selectors:', JSON.stringify(await selectors()));
console.log('  stored   :', JSON.stringify(await storedSteps()));

console.log('\n--- pick #2 (this is the reported failure) ---');
await pickAt(1, 'second');
await panel.waitForTimeout(1500);      // past the auto-save debounce
const rowsAfter = await pointRows();
const selAfter = await selectors();
const storedAfter = await storedSteps();
// did the auto-save even attempt? the worker records every save-request
const events = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.diagnosticEvents ?? []).map((e) => `${e.kind}${e.automationId ? ':' + e.automationId : ''}${e.stepCount !== undefined ? ' steps=' + e.stepCount : ''}${e.error ? ' ERR=' + e.error : ''}`);
});
console.log('  worker events:', JSON.stringify(events));
console.log('  point rows:', rowsAfter);
console.log('  selectors :', JSON.stringify(selAfter));
console.log('  stored    :', JSON.stringify(storedAfter));

check('the second point still exists after picking it', rowsAfter === 2, `${rowsAfter} row(s)`);
check('and both selectors are filled', selAfter.length === 2 && selAfter.every((s) => s.length > 0), JSON.stringify(selAfter));
const finderKeys = storedAfter.flatMap((r) => r.steps.map((f) => f ? Object.entries(f).filter(([k]) => k !== 'strategy' && f[k]).map(([k]) => k).join('+') : 'MISSING'));
check('and storage holds BOTH points, each naming an element', storedAfter.some((r) => r.steps.length === 2)
  && finderKeys.every((k) => k !== 'MISSING'), JSON.stringify(finderKeys));
check('the two points point at DIFFERENT elements', new Set(selAfter).size === selAfter.length, JSON.stringify(selAfter));

server.close();
await ctx.close();
console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);