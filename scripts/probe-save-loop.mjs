#!/usr/bin/env node
/**
 * "همش پشت هم سیو میکنه نمیزاره تایم جدید وارد کنم" - it saves back to back and will not let me enter a new time.
 *
 * The prime suspect is a loop I may have introduced: the focus restore keeps re-focusing the time field after every
 * render, and if a render REMOVES a focused node the browser fires `blur` on it - whose handler commits, arms the
 * auto-save and schedules ANOTHER render. That would produce exactly this: saves one after another, and a field that
 * cannot be typed into.
 *
 * This counts, second by second, the saves, the renders and whether the typed value survives - and it does not try to
 * fix anything, so the number is evidence rather than a guess.
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

const PAGE = '<!doctype html><meta charset="utf-8"><style>button{position:fixed;top:100px;left:60px;width:150px;height:70px}</style><button id="target">buy</button>';
const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-loop-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 12 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(pageUrl);

const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message.slice(0, 160)));
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

/** Count renders by watching the time input node: a re-render replaces it. */
await panel.evaluate(() => {
  window.__replaced = 0;
  window.__decorated = 0;
  const root = document.getElementById('root');
  const obs = new MutationObserver((recs) => {
    for (const r of recs) {
      for (const n of r.removedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.('input.time-input') || n.querySelector?.('input.time-input')) window.__replaced += 1;
      }
    }
  });
  obs.observe(root, { childList: true, subtree: true });
  // and count how many blur events the time field sees, with whether the node was still in the document
  document.addEventListener('focusout', (e) => {
    if (e.target?.matches?.('input.time-input')) {
      window.__decorated += 1;
      (window.__blurs ??= []).push({ connected: e.target.isConnected });
    }
  }, true);
});

const saves = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const ev = all.diagnosticEvents ?? [];
  return ev.filter((e) => e.kind === 'save-request').length;
});
const counters = () => panel.evaluate(() => ({
  replaced: window.__replaced,
  blurEvents: window.__decorated,
  blurs: (window.__blurs ?? []).slice(-8),
  value: document.querySelector('input.time-input')?.value ?? null,
  focused: document.activeElement === document.querySelector('input.time-input'),
}));

console.log('=== pick a point so the auto-save has something to save ===');
const pickBox = await panel.evaluate(() => {
  const b = document.querySelector('main button.pick');
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(pickBox.x, pickBox.y);
await panel.waitForTimeout(500);
await page.bringToFront();
const t = await page.evaluate(() => {
  const r = document.getElementById('target').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(t.x, t.y);
await panel.waitForTimeout(1600);
await panel.bringToFront();
await panel.waitForTimeout(400);
console.log('  after picking:', JSON.stringify(await counters()));

console.log('\n=== put the caret in the time field and DO NOTHING for 6 seconds ===');
const box = await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(box.x, box.y);
const base = await saves();
const c0 = await counters();
for (let s = 1; s <= 6; s += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const c = await counters();
  const sv = await saves();
  console.log(`  t+${s}s  saves+${sv - base}  renderReplacements+${c.replaced - c0.replaced}  blurs+${c.blurEvents - c0.blurEvents}  value=${c.value} focused=${c.focused}`);
}

console.log('\n=== now TYPE a new time, one key at a time, and see whether it survives ===');
const typed = [];
for (const ch of '10:32:33.250') {
  await panel.keyboard.type(ch, { delay: 0 });
  await new Promise((r) => setTimeout(r, 130));
  typed.push(await panel.evaluate(() => document.querySelector('input.time-input')?.value ?? null));
}
console.log('  after each keystroke:', JSON.stringify(typed));
const after = await counters();
console.log('  final:', JSON.stringify(after));
console.log(`  saves during typing: ${(await saves()) - base}`);

console.log('\n=== and clicking "New time" - does it add one? ===');
const before = await panel.evaluate(() => document.querySelectorAll('.event-chip').length);
const nt = await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /New time/.test(x.textContent));
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(nt.x, nt.y);
await panel.waitForTimeout(1500);
const afterChips = await panel.evaluate(() => document.querySelectorAll('.event-chip').length);
console.log(`  chips ${before} -> ${afterChips}   (a new time should add one)`);

console.log('\n=== did the loop continue after all that? (5 more idle seconds) ===');
const b2 = await saves();
const c2 = await counters();
await new Promise((r) => setTimeout(r, 5000));
const c3 = await counters();
console.log(`  saves+${(await saves()) - b2}  renderReplacements+${c3.replaced - c2.replaced}  blurs+${c3.blurEvents - c2.blurEvents}`);
console.log('  recent blurs:', JSON.stringify(c3.blurs));

server.close();
await ctx.close();
process.exit(0);