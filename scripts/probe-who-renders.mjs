#!/usr/bin/env node
/**
 * WHO IS RENDERING EVERY SECOND?
 *
 * `probe-save-loop` measured 5 renders in 5 idle seconds, and no `setInterval` exists in the panel - so something is
 * scheduling itself. `render()` now records its own stack; this drains that record and prints the callers by frequency,
 * which names the culprit instead of guessing at it.
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

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-whorender-')));
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
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

// pick a point, so the state resembles the user's
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
await panel.waitForTimeout(1800);
await panel.bringToFront();

console.log('=== drain the render record, then idle 6 seconds with NOTHING touched ===');
await panel.evaluate(() => { window.__renderStacks = []; });
await new Promise((r) => setTimeout(r, 6000));
const stacks = await panel.evaluate(() => window.__renderStacks ?? []);
console.log(`  renders while idle: ${stacks.length}`);

const counts = new Map();
for (const s of stacks) counts.set(s, (counts.get(s) ?? 0) + 1);
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [stack, n] of sorted.slice(0, 6)) {
  console.log(`\n  ${n}x  ${stack}`);
}

console.log('\n=== and with the caret sitting in the time field ===');
const box = await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(box.x, box.y);
await panel.evaluate(() => { window.__renderStacks = []; });
const typed = [];
for (const ch of '103233250') {
  await panel.keyboard.type(ch, { delay: 0 });
  await new Promise((r) => setTimeout(r, 120));
  typed.push(await panel.evaluate(() => document.querySelector('input.time-input')?.value ?? null));
}
const typingStacks = await panel.evaluate(() => window.__renderStacks ?? []);
console.log('  value after each key:', JSON.stringify(typed));
console.log(`  renders during 9 keystrokes: ${typingStacks.length}`);
const c2 = new Map();
for (const s of typingStacks) c2.set(s, (c2.get(s) ?? 0) + 1);
for (const [stack, n] of [...c2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
  console.log(`\n  ${n}x  ${stack}`);
}

server.close();
await ctx.close();
process.exit(0);