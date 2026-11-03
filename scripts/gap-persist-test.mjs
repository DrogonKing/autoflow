#!/usr/bin/env node
/**
 * DOES THE CLICK GAP SURVIVE CLOSING AND REOPENING THE PANEL?
 *
 * The user reported the gap "was not applied". The panel rebuilt its rows field by field from storage, so a field not named
 * in that rebuild is silently lost on every reload - which is exactly the symptom: a value that appears to be set and then
 * is not. The earlier harness checked storage IMMEDIATELY after setting the value and never reopened the panel, so this
 * path was untested.
 *
 * This test does the whole round trip: set 20 ms, close the panel page, open it again, read the value from storage AND from
 * the field, then run and measure the gaps.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';
import { assertFreshBuild } from './lib/fresh-build.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

// Refuse to measure a bundle that predates its source. MEASURED three times: a stale dist/ made a fix look broken twice and
// hid a real bug once. See scripts/lib/fresh-build.mjs.
assertFreshBuild(ROOT);

const PAGE = `<!doctype html><meta charset="utf-8"><title>gap</title>
<style>button{position:absolute;width:180px;height:44px} #b1{top:60px;left:40px} #b2{top:120px;left:40px} #b3{top:180px;left:40px}</style>
<button id="b1">one</button><button id="b2">two</button><button id="b3">three</button>
<script>window.HITS=[];for(const id of ['b1','b2','b3']){document.getElementById(id).addEventListener('click',()=>{window.HITS.push({id,t:performance.now()})});}</script>`;
const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-gap2-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 950 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 20 && !sw; i += 1) { await new Promise((r) => setTimeout(r, 500)); [sw] = ctx.serviceWorkers(); }
if (!sw) { console.log('no service worker'); process.exit(1); }
const extId = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(pageUrl);

const openPanel = async () => {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/panel.html`);
  await p.waitForLoadState('domcontentloaded');
  await p.waitForFunction(() => document.querySelectorAll('nav.tabs button').length > 0, { timeout: 25000 });
  await p.evaluate(() => [...document.querySelectorAll('nav.tabs button')].find((b) => /Basic|پایه/.test(b.textContent))?.click());
  await p.waitForFunction(() => document.querySelector('input.time-input') !== null, { timeout: 15000 });
  return p;
};
let panel = await openPanel();

const clickText = async (re) => {
  const at = await panel.evaluate((p) => {
    const b = [...document.querySelectorAll('button')].find((x) => new RegExp(p, 'i').test(x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, re);
  if (!at) return false;
  await panel.mouse.click(at.x, at.y);
  await panel.waitForTimeout(750);
  return true;
};

const pick = async (id) => {
  const pb = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button.pick')].filter((x) => x.offsetParent).pop();
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!pb) return false;
  await panel.mouse.click(pb.x, pb.y);
  await panel.waitForTimeout(600);
  await page.bringToFront();
  const t = await page.evaluate((sel) => {
    const el = document.getElementById(sel);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  await page.mouse.click(t.x, t.y);
  await panel.waitForTimeout(1400);
  await panel.bringToFront();
  await panel.waitForTimeout(350);
  return true;
};

const records = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => ({ id: a.id, steps: (a.steps ?? []).length, gap: a.options?.clickGapMs ?? null, urls: a.urls ?? [] }));
});

console.log('================ setup: three picks ================');
for (const b of ['b1', 'b2', 'b3']) { await clickText('^\\+\\s*Add a point'); await pick(b); }
await panel.waitForTimeout(2200);
let rec = await records();
console.log('  records:', JSON.stringify(rec));
const id = rec[0].id;

const pattern = `${pageUrl}*`;
await sw.evaluate(async ({ id, pattern }) => {
  const all = await chrome.storage.local.get(null);
  const list = all.automations ?? [];
  const a = list.find((x) => x.id === id);
  if (a) { a.urls = [pattern]; await chrome.storage.local.set({ automations: list }); }
}, { id, pattern });

console.log('\n================ set the gap to 20 ms ================');
const gear = await panel.evaluate(() => {
  const g = document.querySelector('.time-with-save .time-settings');
  if (!g) return null;
  const r = g.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
console.log('  gear:', JSON.stringify(gear));
await panel.mouse.click(gear.x, gear.y);
await panel.waitForTimeout(600);
console.log('  gear position:', JSON.stringify({ gearY: Math.round(gear.y) }));

const field = await panel.evaluate(() => {
  const f = document.querySelector('input.gap-input');
  const time = document.querySelector('input.time-input');
  if (!f) return null;
  const r = f.getBoundingClientRect();
  const tr = time.getBoundingClientRect();
  return {
    x: r.x + r.width / 2, y: r.y + r.height / 2, v: f.value,
    // WHERE the box is matters as much as that it exists: it was reported as "the place is wrong"
    belowTheTimeField: r.top >= tr.bottom,
    distanceBelow: Math.round(r.top - tr.bottom),
    inViewport: r.top > 0 && r.bottom < window.innerHeight,
    viewportHeight: window.innerHeight,
  };
});
console.log('  field:', JSON.stringify(field));
await panel.mouse.click(field.x, field.y);
await panel.waitForTimeout(200);
await panel.keyboard.press('Control+a');
/**
 * PERSIAN DIGITS, typed as a Persian keyboard produces them.
 *
 * Reported: "الان درست شد فقط اعداد فارسی قبول نمیکنه". `insertText` is used rather than `type` because the field's
 * handler reads the VALUE, and this asserts what a user would actually end up with - U+06F2 U+06F0, not ASCII.
 */
await panel.keyboard.insertText('۲۰');
const typed = await panel.evaluate(() => document.querySelector('input.gap-input')?.value);
console.log('  typed (Persian):', JSON.stringify(typed));
await panel.keyboard.press('Enter');
await panel.waitForTimeout(2400);
const afterPersian = await records();
console.log('  after Enter :', JSON.stringify(afterPersian));
console.log(`  ${afterPersian[0]?.gap === 20 ? 'ok  ' : 'HIGH'} Persian digits ۲۰ were accepted as 20 ms   gap=${afterPersian[0]?.gap}`);

console.log('\n================ THE UNTESTED STEP: close and reopen the panel ================');
await panel.close();
panel = await openPanel();
await panel.waitForTimeout(1200);
const afterReopen = await records();
console.log('  storage after reopen:', JSON.stringify(afterReopen));

const seenField = await panel.evaluate(() => {
  const g = document.querySelector('.time-with-save .time-settings');
  return g ? 'gear present' : 'NO GEAR';
});
console.log('  panel shows:', seenField);

const stillTwenty = afterReopen[0]?.gap === 20;
console.log(`\n  ${stillTwenty ? 'ok  ' : 'HIGH'} the gap survives reopening the panel   gap=${afterReopen[0]?.gap}`);

console.log('\n================ and does it still apply? ================');
await page.evaluate(() => { window.HITS = []; });
await page.bringToFront();
await panel.evaluate(async (aid) => { try { await chrome.runtime.sendMessage({ type: 'start-run', automationId: aid }); } catch { /* noop */ } }, id);
await page.waitForTimeout(3000);
const hits = await page.evaluate(() => window.HITS);
const at = hits.map((h) => h.t);
const gaps = at.slice(1).map((t, i) => Math.round(t - at[i]));
console.log('  hits:', JSON.stringify(hits.map((h) => h.id)), '| gaps(ms):', JSON.stringify(gaps));

/**
 * THE ENGINE'S OWN TIMELINE, not my inference from the page.
 *
 * Each trace entry carries `at` = ms since the run started, so the spacing between the step entries is what the engine
 * actually did: the sleep it performed plus the click it awaited. Reading this separates "the gap was not applied" from
 * "the gap was applied but the page recorded the clicks differently".
 */
const trace = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const runs = all.runs ?? all.runHistory ?? [];
  const last = runs[0] ?? runs[runs.length - 1];
  return (last?.trace ?? []).map((e) => ({ t: e.type, at: e.at, id: e.stepId }));
});
console.log('  engine trace:', JSON.stringify(trace));
console.log(`  ${gaps.length === 2 && gaps.every((g) => g >= 19 && g <= 34) ? 'ok  ' : 'HIGH'} the picks are about 20 ms apart after the round trip`);

// THE BOX MUST BE ATTACHED TO THE FIELD, which is the placement the user asked for
console.log(`  ${field.belowTheTimeField && field.inViewport ? 'ok  ' : 'HIGH'} the gap box sits directly under the time field, in view`
  + ` (${field.distanceBelow}px below, viewport ${field.viewportHeight}px)`);

server.close();
await ctx.close();
process.exit(0);