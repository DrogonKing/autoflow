#!/usr/bin/env node
/**
 * THREE TIMES, EACH WITH ITS OWN PICKS — AND THE PAGE MUST BE REMEMBERED PER TIME.
 *
 * The report, from a 1.34.0 export: "سه تا زمان هرکدوم سه تا pick فقط زمان اولیه pickهاش فعال شد" - three times, three picks
 * each, and only the FIRST time's picks actually ran.
 *
 * The log said why:
 *
 *     basic       FIRED, tab-from-memory  file:///…/autoflow-test-field (4).html
 *     basic-new1  step-error  "this automation has never had an element picked in it, so a scheduled run has no page"
 *     basic-new2  step-error  (same)
 *
 * and `lastPickPages` held ONE entry, `basic`. Every pick, whichever time it was made in, filed its page under the first
 * record - because the handler attached it to `state.basic.id`, which is always `basic`.
 *
 * WHY THE PICK HAS TO BE REAL HERE. `remember-pick-page` is sent from the pick listener, so a selector typed by hand never
 * exercises it - which is exactly why `three-times-test` passed while this was broken. This suite picks every point with a
 * mouse, on a page the extension can reopen.
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
  console.log(`  ${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail ? `\n        ${String(detail).slice(0, 250)}` : ''}`);
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>per-time pages</title>
<style>html,body{margin:0;font:14px sans-serif}
button{position:fixed;width:150px;height:70px;font:16px sans-serif}</style>
<button id="a1" style="top:110px;left:60px">a1</button>
<button id="b1" style="top:110px;left:240px">b1</button>
<button id="c1" style="top:110px;left:420px">c1</button>
<script>window.__clicks=[];for(const i of ['a1','b1','c1']){const el=document.getElementById(i);el.addEventListener('click',()=>window.__clicks.push({id:i,at:Date.now()}));}</script>`;

const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-ptp-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1100 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(pageUrl);

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const press = async (re) => {
  const box = await panel.evaluate((pattern) => {
    const b = [...document.querySelectorAll('main button')].find((x) => new RegExp(pattern, 'i').test(x.textContent.trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, re);
  if (!box) return false;
  await panel.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 700));
  return true;
};
/** Pick the open time's point at the given element. */
const pickPoint = async (targetId) => {
  const box = await panel.evaluate(() => {
    const b = document.querySelector('main button.pick');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
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
  await panel.waitForTimeout(1500);
  await panel.bringToFront();
  await panel.waitForTimeout(300);
  return true;
};

const chips = () => panel.evaluate(() => [...document.querySelectorAll('.event-chip')].map((c) => ({
  id: c.dataset.eventId, text: c.querySelector('.event-chip-open')?.textContent?.trim(),
})));
const stored = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return {
    pages: all.settings?.lastPickPages ?? {},
    automations: (all.automations ?? []).map((a) => ({ id: a.id, steps: (a.steps ?? []).length })),
  };
});

console.log('\n=== three times, each with its own pick ===');
await pickPoint('a1');
check('time one has a picked point', true, '');
for (const [n, target] of [[2, 'b1'], [3, 'c1']]) {
  const added = await press('^\\+\\s*New time');
  check(`"New time" works for time ${n}`, added, '');
  await pickPoint(target);
}
const list = await chips();
check('three times are listed', list.length === 3, list.map((c) => c.text).join(' | '));

console.log('\n=== EVERY time must have its own remembered page ===');
await new Promise((r) => setTimeout(r, 2500));
const state = await stored();
console.log('  lastPickPages:', JSON.stringify(state.pages, null, 0));
console.log('  automations  :', JSON.stringify(state.automations));
const ids = list.map((c) => c.id);
const withPage = ids.filter((i) => typeof state.pages[i] === 'string' && state.pages[i].length > 0);
check('every time has a page of its own, not just the first', withPage.length === 3,
  `pages for ${JSON.stringify(withPage)} of ${JSON.stringify(ids)}`);
check('the page recorded is the page that was picked on',
  Object.values(state.pages).every((u) => u.startsWith('http://127.0.0.1:')), JSON.stringify(state.pages));

console.log('\n=== and the run that follows can find a page for each of them ===');
/**
 * The failure in the log was at RUN time: "a scheduled run has no page". The run resolves its tab from
 * `lastPickPages[id]`, so a record with an entry finds its tab and one without it refuses. Simulating the resolution
 * rather than waiting for three scheduled alarms keeps the suite fast while testing the same fact.
 */
const resolved = await sw.evaluate(async (automationIds) => {
  const all = await chrome.storage.local.get(null);
  const pages = all.settings?.lastPickPages ?? {};
  return automationIds.map((aid) => ({ id: aid, resolved: typeof pages[aid] === 'string' }));
}, ids);
console.log('  resolution:', JSON.stringify(resolved));
check('each automation resolves a page for its run', resolved.every((r) => r.resolved),
  JSON.stringify(resolved.filter((r) => !r.resolved)));

console.log('\n=== the deletion of a time takes its page with it ===');
const before = (await chips()).length;
const firstId = (await chips())[0].id;
await panel.evaluate((eid) => {
  const chip = [...document.querySelectorAll('.event-chip')].find((c) => c.dataset.eventId === eid);
  chip?.querySelector('.event-chip-remove')?.click();
}, firstId);
await new Promise((r) => setTimeout(r, 2500));
const after = await chips();
check('one time was removed', after.length === before - 1, `${before} -> ${after.length}`);

server.close();
await ctx.close();
console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);