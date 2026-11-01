#!/usr/bin/env node
/**
 * Typing `103233250` into the time field produced `10:02:33.300`. Trace every keystroke: the raw key, the value before
 * and after, the caret, and whether a selection was active at the moment the key was handled.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-trace-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 12 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
const id = new URL(sw.url()).host;
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message.slice(0, 200)));
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

/** Record every input/keydown/select/focus on the time field, with the caret at that instant. */
await panel.evaluate(() => {
  window.__trace = [];
  const log = (kind, el, extra) => {
    window.__trace.push({
      kind,
      value: el?.value ?? null,
      selStart: el?.selectionStart ?? null,
      selEnd: el?.selectionEnd ?? null,
      key: extra?.key ?? null,
      data: extra?.data ?? null,
      inputType: extra?.inputType ?? null,
    });
  };
  document.addEventListener('keydown', (e) => { if (e.target?.matches?.('input.time-input')) log('keydown', e.target, e); }, true);
  document.addEventListener('select', (e) => { if (e.target?.matches?.('input.time-input')) log('select', e.target); }, true);
  document.addEventListener('focus', (e) => { if (e.target?.matches?.('input.time-input')) log('focus', e.target); }, true);
  document.addEventListener('input', (e) => { if (e.target?.matches?.('input.time-input')) log('input', e.target, e); }, true);
  document.addEventListener('blur', (e) => { if (e.target?.matches?.('input.time-input')) log('blur', e.target); }, true);
});

/**
 * PICK A POINT FIRST - that is the difference between the run that types correctly and the one that does not. Without a
 * point the auto-save returns early, so no save ever runs; with one, the save path is live and this trace shows what it
 * does to the field.
 */
const PAGE = '<!doctype html><meta charset="utf-8"><style>button{position:fixed;top:100px;left:60px;width:150px;height:70px}</style><button id="target">buy</button>';
const http = await import('node:http');
const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const pickBox = await panel.evaluate(() => {
  const b = document.querySelector('main button.pick');
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(pickBox.x, pickBox.y);
await panel.waitForTimeout(500);
await page.bringToFront();
const tgt = await page.evaluate(() => {
  const r = document.getElementById('target').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(tgt.x, tgt.y);
await panel.waitForTimeout(1800);
await panel.bringToFront();
await panel.waitForTimeout(600);
console.log('=== picked. renders so far:', await panel.evaluate(() => (window.__renderStacks ?? []).length));
await panel.evaluate(() => { window.__renderStacks = []; });
server.close();

const box = await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
console.log('=== before the click, the field holds:', await panel.evaluate(() => document.querySelector('input.time-input')?.value));
await panel.mouse.click(box.x, box.y);
await new Promise((r) => setTimeout(r, 300));
console.log('after click (focus):', JSON.stringify(await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  return { value: el.value, selStart: el.selectionStart, selEnd: el.selectionEnd };
})));

const steps = [];
for (const ch of '103233250') {
  await panel.keyboard.type(ch);
  await new Promise((r) => setTimeout(r, 160));
  steps.push(await panel.evaluate(() => {
    const el = document.querySelector('input.time-input');
    return { value: el.value, caret: el.selectionStart, sel: el.selectionEnd - el.selectionStart };
  }));
}
console.log('\n=== after each keystroke ===');
steps.forEach((s, i) => console.log(`  ${i + 1}. typed "${'103233250'[i]}" -> value=${JSON.stringify(s.value)} caret=${s.caret} selected=${s.sel}`));

console.log('\n=== RENDERS WHILE TYPING (this is what corrupts the value) ===');
const rs = await panel.evaluate(() => window.__renderStacks ?? []);
console.log(`  ${rs.length} render(s) during 9 keystrokes`);
const c = new Map();
for (const s of rs) c.set(s, (c.get(s) ?? 0) + 1);
for (const [stack, n] of [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`\n  ${n}x  ${stack}`);
}

console.log('\n=== the event trace (first 24) ===');
const trace = await panel.evaluate(() => (window.__trace ?? []).slice(0, 24));
for (const t of trace) {
  console.log(`  ${t.kind.padEnd(8)} key=${String(t.key ?? '').padEnd(6)} data=${String(t.data ?? '').padEnd(3)} type=${String(t.inputType ?? '').padEnd(14)} value=${String(t.value).padEnd(16)} sel=${t.selStart}..${t.selEnd}`);
}

await ctx.close();
process.exit(0);