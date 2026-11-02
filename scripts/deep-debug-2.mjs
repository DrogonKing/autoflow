#!/usr/bin/env node
/**
 * DEEP DEBUG 2 — "add a time, then set its time", key by key.
 *
 * `deep-debug-1` showed times stored as `0:00:00.090` and `0:00:00` where `09:00:00.000` was typed, in the one sequence a
 * user actually performs: press "New time", then type the time for the new row. The first time typed correctly, so this is
 * about what is different for a time that was just ADDED.
 *
 * Each keystroke's value is printed, so the corruption is visible at the moment it happens rather than inferred from the
 * final record. Nothing is asserted away: every observation is printed.
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

const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<button id="t" style="position:fixed;top:80px;left:60px;width:140px;height:60px">buy</button>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-deep2-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1000 },
});
let [sw] = ctx.serviceWorkers();
for (let i = 0; i < 14 && !sw; i++) { await new Promise((r) => setTimeout(r, 1000)); [sw] = ctx.serviceWorkers(); }
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  *** PANEL ERROR:', e.message.slice(0, 200)));
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const fieldInfo = () => panel.evaluate(() => {
  const f = document.querySelector('input.time-input');
  if (!f) return null;
  return {
    value: f.value,
    focused: document.activeElement === f,
    sel: `${f.selectionStart}..${f.selectionEnd}`,
    chips: document.querySelectorAll('.chip[data-event-id], .event-chip[data-event-id]').length,
  };
});
const records = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => `${a.id}=${a.schedule?.hour}:${String(a.schedule?.minute ?? 0).padStart(2, '0')}:${String(a.schedule?.second ?? 0).padStart(2, '0')}${a.schedule?.ms ? '.' + String(a.schedule.ms).padStart(3, '0') : ''}`);
});
const pressNewTime = async () => {
  const ok = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => /new time/i.test(x.textContent));
    if (!b) return false;
    const r = b.getBoundingClientRect();
    window.__nt = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    return true;
  });
  if (!ok) return false;
  const at = await panel.evaluate(() => window.__nt);
  await panel.mouse.click(at.x, at.y);
  await panel.waitForTimeout(900);
  return true;
};

/** Type into the time field the way a person does: click it, then type the digits one at a time, recording each. */
const typeIntoTime = async (digits, label) => {
  const box = await panel.evaluate(() => {
    const f = document.querySelector('input.time-input');
    const r = f.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await panel.mouse.click(box.x, box.y);
  await panel.waitForTimeout(250);
  const afterClick = await fieldInfo();
  const seen = [];
  for (const ch of digits) {
    await panel.keyboard.type(ch);
    await new Promise((r) => setTimeout(r, 130));
    const info = await fieldInfo();
    seen.push(info.value);
  }
  console.log(`\n  [${label}] after click: ${JSON.stringify(afterClick)}`);
  console.log(`  [${label}] keystrokes : ${JSON.stringify(seen)}`);
  await panel.keyboard.press('Enter');
  await panel.waitForTimeout(700);
  console.log(`  [${label}] after Enter: ${JSON.stringify(await fieldInfo())}`);
};

console.log('================ A. THE FIRST TIME, AS A BASELINE ================');
console.log('  starting state:', JSON.stringify(await fieldInfo()));
await typeIntoTime('080000000', 'first');

console.log('\n================ B. ADD A TIME, THEN TYPE ITS TIME ================');
const added = await pressNewTime();
console.log('  "New time" pressed:', added, '| state:', JSON.stringify(await fieldInfo()));
await typeIntoTime('090000000', 'second');

console.log('\n================ C. AND A THIRD ================');
const added2 = await pressNewTime();
console.log('  "New time" pressed:', added2, '| state:', JSON.stringify(await fieldInfo()));
await typeIntoTime('103000000', 'third');

console.log('\n================ D. WHAT LANDED IN STORAGE ================');
await panel.waitForTimeout(2600);
for (const r of await records()) console.log('   ', r);
console.log('  chips:', JSON.stringify(await fieldInfo()));

console.log('\n================ E. THE FIELDS PRESENT ON SCREEN ================');
const fields = await panel.evaluate(() => {
  const out = [];
  document.querySelectorAll('input.time-input').forEach((f) => {
    const r = f.getBoundingClientRect();
    out.push({ value: f.value, x: Math.round(r.x), y: Math.round(r.y), visible: r.width > 0 });
  });
  return out;
});
console.log('  time inputs:', JSON.stringify(fields));

console.log('\n================ F. FAST TYPING (no delay between keys) ================');
/**
 * The first deep-debug run typed with no delay between keys and a later time was stored as `0:00:00.090` where
 * `09:00:00.000` was entered. Everything above typed slowly and was correct, so the variable to isolate is SPEED - which
 * a real person also produces. Every keystroke is recorded so the corruption is caught at the key that causes it.
 */
const fastType = async (digits, label) => {
  const box = await panel.evaluate(() => {
    const f = document.querySelector('input.time-input');
    const r = f.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await panel.mouse.click(box.x, box.y);
  await panel.waitForTimeout(250);
  const seen = [];
  for (const ch of digits) {
    await panel.keyboard.type(ch);            // no delay at all
    seen.push(await fieldInfo().then((i) => i.value));
  }
  console.log(`  [${label}] as typed : ${JSON.stringify(seen)}`);
  await panel.keyboard.press('Enter');
  await panel.waitForTimeout(800);
  const after = await fieldInfo();
  console.log(`  [${label}] settled : ${JSON.stringify(after)}`);
  return after.value;
};

// a form that HAS a point, so a save actually happens (a point-less time is skipped by design)
const pickOne = async () => {
  const pb = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button.pick')].filter((x) => x.offsetParent).pop();
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!pb) return false;
  await panel.mouse.click(pb.x, pb.y);
  await panel.waitForTimeout(500);
  await page.bringToFront();
  const t = await page.evaluate(() => {
    const r = document.getElementById('t').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(t.x, t.y);
  await panel.waitForTimeout(1500);
  await panel.bringToFront();
  await panel.waitForTimeout(400);
  return true;
};

await pressNewTime();
await pickOne();
const beforeFast = await fieldInfo();
console.log('  before fast typing:', JSON.stringify(beforeFast));
const fastValue = await fastType('093045000', 'fast');
await panel.waitForTimeout(2400);
const storedAfterFast = await records();
console.log('  storage:', JSON.stringify(storedAfterFast));
console.log(`  typed 09:30:45.000 -> field ${fastValue} -> stored ${JSON.stringify(storedAfterFast.filter((r) => /9:30/.test(r)))}`);

server.close();
await ctx.close();
process.exit(0);