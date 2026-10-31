#!/usr/bin/env node
/**
 * Why does a scheduled run not click? Report every observable step.
 *
 * Four attempts have failed and each was a guess. This stops guessing: it wires console and worker listeners,
 * arms the schedule, and prints what each layer says - the schedule, the alarm, the run, the content script,
 * and the page. The failure is in one of them and this makes it readable.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const PAGE = path.join(os.tmpdir(), `af-probe-${process.pid}.html`);
writeFileSync(PAGE, `<!doctype html><meta charset="utf-8"><button id="b" style="width:200px;height:60px">خرید</button>
<script>window.__pressedAt=null;document.getElementById('b').addEventListener('click',()=>{window.__pressedAt=Date.now();document.title='pressed';});</script>`);

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-probe-')));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
});

let worker = null;
for (let i = 0; i < 50 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 300));
}
if (!worker) { console.error('NO WORKER'); await ctx.close(); process.exit(1); }
const id = new URL(worker.url()).host;
console.log(`worker: ${id}`);

worker.on('console', (m) => console.log(`  [worker:${m.type()}] ${m.text().slice(0, 200)}`));

const bridge = await ctx.newPage();
await bridge.goto(`chrome-extension://${id}/options.html`);
bridge.on('console', (m) => console.log(`  [bridge:${m.type()}] ${m.text().slice(0, 200)}`));

const page = await ctx.newPage();
page.on('console', (m) => console.log(`  [page:${m.type()}] ${m.text().slice(0, 200)}`));
await page.goto(pathToFileURL(PAGE).href);
await page.waitForTimeout(600);

const tabId = await bridge.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.startsWith('file://'))?.id ?? null);
console.log(`page tab id: ${tabId}`);
console.log(`page url: ${await page.url()}`);

// does the content script reach a file:// page at all?
const injected = await page.evaluate(() => document.documentElement.getAttribute('data-autoflow-content'));
console.log(`content script marker: ${injected}`);

const now = Date.now();
// ALIGN TO A WHOLE SECOND. The schedule carries hour/minute/second only, so the instant the extension targets
// is the START of that second. Comparing against a fractional-millisecond value made every run look 0-999ms
// early - an artefact of this script, not of the extension. Rounding up to the next whole second removes it.
const target = new Date(Math.ceil((now + 12000) / 1000) * 1000);
const sched = { kind: 'daily', hour: target.getHours(), minute: target.getMinutes(), second: target.getSeconds() };
console.log(`target: ${target.toLocaleTimeString()} local  (in ${Math.round((target - now) / 1000)}s)`);
console.log(`schedule: ${JSON.stringify(sched)}`);

const armed = await bridge.evaluate(async ({ sched, tabId }) => {
  const automation = {
    id: 'probe', name: 'probe', enabled: true, urls: [],
    steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#b' } }],
    schedule: sched, options: { stepDelayMs: 0 },
  };
  const saved = await chrome.runtime.sendMessage({ type: 'save-automation', automation });
  const one = await chrome.runtime.sendMessage({ type: 'schedule-one', automationId: 'probe' });
  const alarms = await chrome.alarms.getAll();
  const listed = await chrome.runtime.sendMessage({ type: 'list-scheduled' });
  return { saved, one, alarms, listed, tabId };
}, { sched, tabId, target: target.getTime() });

console.log(`\nsave: ${JSON.stringify(armed.saved).slice(0, 120)}`);
console.log(`schedule-one: ${JSON.stringify(armed.one)}`);
console.log(`alarms: ${JSON.stringify(armed.alarms)}`);
console.log(`listed: ${JSON.stringify(armed.listed).slice(0, 300)}`);

// wait past the target and watch
const until = target.getTime() + 9000;
let pressed = null;
while (Date.now() < until && !pressed) {
  pressed = await page.evaluate(() => window.__pressedAt).catch(() => null);
  if (!pressed) await new Promise((r) => setTimeout(r, 100));
}

console.log(`\n=== RESULT ===`);
console.log(`pressed: ${pressed ? new Date(pressed).toLocaleTimeString() : 'NO'}`);
if (pressed) console.log(`offset: ${pressed - target.getTime()}ms`);
const runs = await bridge.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'list-runs' }))?.runs?.slice(0, 3));
console.log(`runs: ${JSON.stringify(runs).slice(0, 600)}`);
const active = await bridge.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'get-active-run' }))?.run);
console.log(`active run: ${JSON.stringify(active).slice(0, 300)}`);

await ctx.close();
process.exit(0);