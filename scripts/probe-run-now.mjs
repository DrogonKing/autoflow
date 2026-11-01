#!/usr/bin/env node
/**
 * Does "Run now" click the open time's point? Print everything rather than assert, because the previous attempt gave
 * `[]` which is equally consistent with "the run never started" and "the click went to the page but the page's listener
 * was not there".
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

const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title>
<style>html,body{margin:0} #pad1{position:fixed;top:200px;left:200px;width:200px;height:90px}</style>
<button id="pad1">click me</button>
<script>window.__clicks=[];document.getElementById('pad1').addEventListener('click',()=>window.__clicks.push(Date.now()));</script>`;

const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-rn-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1100 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;

const page = await ctx.newPage();
await page.goto(url);
console.log('page loaded, listener present:', await page.evaluate(() => typeof window.__clicks === 'object'));

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 15000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

// one time, one point, saved through the button so the state is unambiguous
await panel.evaluate(() => {
  const inputs = [...document.querySelectorAll('main input')].filter((x) => !/time-input/.test(x.className));
  const i = inputs[inputs.length - 1];
  i.value = '#pad1';
  i.dispatchEvent(new Event('change', { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 400));
const box = await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /^(save|ذخیره)$/i.test(x.textContent.trim()));
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(box.x, box.y);
await new Promise((r) => setTimeout(r, 1500));
console.log('after Save, stored:', await sw.evaluate(async () => (await chrome.storage.local.get(null)).automations?.length ?? 0));

console.log('\n--- Run now ---');
const runBox = await panel.evaluate(() => {
  const b = [...document.querySelectorAll('main button')].find((x) => /run now|اجرا/i.test(x.textContent.trim()));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.textContent.trim() };
});
console.log('run button:', JSON.stringify(runBox));
if (runBox) await panel.mouse.click(runBox.x, runBox.y);
await new Promise((r) => setTimeout(r, 1000));

const events = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const tabs = await chrome.tabs.query({});
  const pageTabs = tabs.map((t) => `${t.id} ${t.url?.slice(0, 45)}`);
  return {
    pageTabs,
    events: (all.diagnosticEvents ?? []).slice(-10).map((e) => `${e.kind}${e.automationId ? ':' + e.automationId : ''}${e.tabId !== undefined ? ' tab=' + e.tabId : ''}${e.error ? ' ERR=' + e.error : ''}${e.detail ? ' (' + String(e.detail).slice(0, 70) + ')' : ''}`),
  };
});
console.log('open tabs:'); for (const t of events.pageTabs) console.log('   ', t);
console.log('diagnostic events:');
for (const e of events.events) console.log('   ', e);

await page.bringToFront();
await new Promise((r) => setTimeout(r, 1200));
console.log('page clicks:', JSON.stringify(await page.evaluate(() => window.__clicks ?? [])));
console.log('panel status text:', JSON.stringify(await panel.evaluate(() => document.querySelector('.preview, .status, main .hint')?.textContent ?? null)));

server.close();
await ctx.close();
process.exit(0);
