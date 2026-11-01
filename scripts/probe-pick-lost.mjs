#!/usr/bin/env node
/**
 * A pick arrives and the selector is still empty. Where does it get lost?
 *
 * `pick-confirm` passes and the others do not, so the difference between what they do is the clue: it presses the
 * control. This one presses Pick in the Basic form, clicks the page, then prints everything the listener recorded -
 * `__pickDebug` is exactly that log.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';

const ROOT = '/root/autoflow';
const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title>
<style>html,body{margin:0} #pad2{position:fixed;top:150px;left:150px;width:200px;height:90px;font:18px sans-serif}</style>
<button id="pad2">نقطه ۲</button>`;

const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const p = mkdtempSync(path.join(os.tmpdir(), 'af-pick-'));
const ctx = await chromium.launchPersistentContext(p, {
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(url);
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 800));

console.log('state before pick:', JSON.stringify(await panel.evaluate(() => ({
  hasBasicEvents: Boolean(window.__state?.basicEvents),
}))));

// press the Pick control with a REAL mouse
const box = await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button.pick')][0];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
console.log('pick button box:', JSON.stringify(box));
if (box) await panel.mouse.click(box.x, box.y);
await panel.waitForTimeout(500);

console.log('after pressing Pick, tab:', await panel.evaluate(() => document.querySelector('nav.tabs button.active')?.textContent));

// click the element on the page
await page.bringToFront();
const target = await page.evaluate(() => {
  const el = document.getElementById('pad2');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(target.x, target.y);
await panel.waitForTimeout(1600);
await panel.bringToFront();
await panel.waitForTimeout(400);

console.log('\n--- the panel after the pick ---');
console.log('the point debug log:', JSON.stringify(await panel.evaluate(() => window.__pickDebug ?? null)).slice(0, 700));
console.log('selector inputs:', JSON.stringify(await panel.evaluate(() =>
  [...document.querySelectorAll('main input')].filter((x) => /mono/.test(x.className) && !/time-input/.test(x.className)).map((x) => x.value))));
console.log('pick buttons:', JSON.stringify(await panel.evaluate(() => [...document.querySelectorAll('main button.pick')].map((b) => b.textContent.trim()))));

await ctx.close();
server.close();
process.exit(0);
