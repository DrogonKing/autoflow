#!/usr/bin/env node
/**
 * THE REAL SCENARIO: a form that has a picked point, so the auto-save actually RUNS.
 *
 * `probe-time-typing` step 1 kept focus while typing - but that form had no point yet, so the auto-save returned early
 * (`anyUsable` false) and never saved anything. The user's form HAS points. This probe reproduces that: pick a point,
 * then sit in the time field and type, touching NOTHING, and watch whether the auto-save takes the field away.
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

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-as-')));
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

/** Pick the open time's point, for real. */
const pickPoint = async () => {
  const box = await panel.evaluate(() => {
    const b = document.querySelector('main button.pick');
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await panel.mouse.click(box.x, box.y);
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
};

/** A transcript of focus/caret/value over time, sampled every 120ms, plus every re-render the panel performs. */
const watch = async (label, seconds, duringMs) => {
  const samples = [];
  const t0 = Date.now();
  let typed = false;
  while (Date.now() - t0 < seconds * 1000) {
    const s = await panel.evaluate(() => {
      const el = document.querySelector('input.time-input');
      return {
        t: Date.now(),
        value: el?.value ?? null,
        focused: document.activeElement === el,
        active: document.activeElement ? `${document.activeElement.tagName}.${String(document.activeElement.className).split(' ')[0]}` : 'none',
        caret: (() => { try { return el?.selectionStart ?? null; } catch { return null; } })(),
        // a marker survives only if the SAME element does; a new one has none
        sameElement: el?.dataset?.watchMark ?? null,
      };
    });
    samples.push(s);
    if (!typed && Date.now() - t0 >= duringMs) {
      typed = true;
      await panel.keyboard.type('7', { delay: 30 });
      samples.push({ ...(await panel.evaluate(() => {
        const el = document.querySelector('input.time-input');
        return { t: Date.now(), value: el?.value ?? null, focused: document.activeElement === el, active: document.activeElement?.tagName, caret: (() => { try { return el?.selectionStart ?? null; } catch { return null; } })(), sameElement: el?.dataset?.watchMark ?? null };
      })), typedHere: true });
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  const lost = samples.filter((s) => s.focused === false);
  console.log(`\n=== ${label} ===`);
  console.log(`  samples: ${samples.length}, focus lost in ${lost.length}`);
  if (lost.length) {
    const first = lost[0];
    console.log(`  FIRST LOSS after ${first.t - t0}ms: value=${first.value} active=${first.active} sameElement=${first.sameElement}`);
    console.log(`  the sample just before: ${JSON.stringify(samples[samples.indexOf(first) - 1] ?? null)}`);
  }
  const marked = samples.filter((s) => s.sameElement);
  console.log(`  element replaced: ${marked.length === 0 ? 'YES' : `no (marker seen ${marked.length}×)`}`);
  const typedSample = samples.find((s) => s.typedHere);
  if (typedSample) console.log(`  the keystroke landed: value=${typedSample.value} focused=${typedSample.focused} caret=${typedSample.caret}`);
  return samples;
};

console.log('=== pick a point so the auto-save has something to save ===');
await pickPoint();
console.log('  stored now:', JSON.stringify(await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => `${a.id}(${a.steps?.length})`);
})));

// mark the field so a replacement is visible
await panel.evaluate(() => { const el = document.querySelector('input.time-input'); if (el) el.dataset.watchMark = 'm1'; });
const box = await panel.evaluate(() => {
  const el = document.querySelector('input.time-input');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await panel.mouse.click(box.x, box.y);
await panel.keyboard.press('Control+A');
await panel.keyboard.type('10:32:33.250', { delay: 35 });
console.log('  typed, focus:', JSON.stringify(await panel.evaluate(() => ({ focused: document.activeElement === document.querySelector('input.time-input') }))));

await watch('typing, then 4s of NOTHING (auto-save fires in here)', 5, 400);