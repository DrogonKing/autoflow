#!/usr/bin/env node
/**
 * THREE TIMES, EACH WITH ITS OWN POINTS - DOES EACH ONE ACTUALLY GET ARMED?
 *
 * The user's report: "باگ دوم فقط زمان اولی رو شلیک کرد و pickهای زمان دوم و سوم شلیک نشدن" - only the first time fired.
 *
 * Their log is from 1.21.0, where several times did not exist yet, so this reproduces the workflow on the CURRENT build:
 * add three times, give each a point, Save, then ask storage and the alarm registry what actually exists.
 *
 * The interesting distinction is between three things that all look like "it did not fire":
 *   - the record was never stored
 *   - the record is stored but no alarm was armed
 *   - alarms exist but the run only performed the first event's steps
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

const p = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-3times-')));
const ctx = await chromium.launchPersistentContext(p, {
  executablePath: CHROME,
  headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1100 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;

const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 15000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const typeTime = async (digits) => {
  const f = await panel.$('input.time-input');
  await f.click();
  await panel.keyboard.press('Control+A');
  await panel.keyboard.press('Backspace');
  await panel.keyboard.type(digits, { delay: 20 });
  await panel.evaluate(() => document.querySelector('input.time-input')?.blur());
  await new Promise((r) => setTimeout(r, 400));
};
const timeValue = () => panel.evaluate(() => document.querySelector('input.time-input')?.value ?? '');
const clickByText = async (re) => {
  const box = await panel.evaluate((pattern) => {
    const b = [...document.querySelectorAll('main button')].find((x) => new RegExp(pattern).test(x.textContent.trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, re);
  if (!box) return false;
  await panel.mouse.click(box.x, box.y);
  return true;
};

console.log('=== build three times, each with one point ===');
// event 1
await typeTime('103233250');
console.log('  time 1:', await timeValue());
// give it a point
await panel.evaluate(() => {
  const i = [...document.querySelectorAll('main input')].find((x) => /grow mono$/.test(x.className));
  if (i) { i.value = '#pad1'; i.dispatchEvent(new Event('change', { bubbles: true })); }
});
console.log('  point 1 set');

for (const [n, digits] of [[2, '103240000'], [3, '103500000']]) {
  const added = await clickByText('^\\+\\s*New time');
  console.log(`  pressed New time for #${n}:`, added);
  await new Promise((r) => setTimeout(r, 700));
  await typeTime(digits);
  console.log(`  time ${n}:`, await timeValue());
  await panel.evaluate(() => {
    const i = [...document.querySelectorAll('main input')].find((x) => /grow mono$/.test(x.className));
    if (i) { i.value = `#pad${i ? '' : ''}` || '#pad2'; i.dispatchEvent(new Event('change', { bubbles: true })); }
  });
}

console.log('\n=== what the panel holds now ===');
console.log('  chips:', JSON.stringify(await panel.evaluate(() => [...document.querySelectorAll('.event-chip')].map((c) => c.textContent.trim()))));

console.log('\n=== Save ===');
const landed = await clickByText('^save$|^ذخیره$');
console.log('  real mouse click found a button:', landed);
await new Promise((r) => setTimeout(r, 1200));
const afterMouse = await sw.evaluate(async () => (await chrome.storage.local.get(null)).automations?.length ?? 0);
console.log('  automations after the mouse click:', afterMouse);
if (afterMouse === 0) {
  console.log('  -> falling back to a direct click, to separate "the click missed" from "the save path is broken"');
  const direct = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('main button')].find((x) => /^(save|ذخیره)$/i.test(x.textContent.trim()));
    if (!b) return 'no button';
    b.click();
    return 'clicked';
  });
  console.log('  direct click:', direct);
  await new Promise((r) => setTimeout(r, 1200));
  const afterDirect = await sw.evaluate(async () => (await chrome.storage.local.get(null)).automations?.length ?? 0);
  console.log('  automations after the direct click:', afterDirect);
}
await new Promise((r) => setTimeout(r, 1500));
console.log('  notice:', JSON.stringify(await panel.evaluate(() => document.querySelector('.saved-note')?.textContent ?? null)));
console.log('  error :', JSON.stringify(await panel.evaluate(() => document.querySelector('.warn')?.textContent ?? null)));
console.log('  button:', JSON.stringify(await panel.evaluate(() => [...document.querySelectorAll('main button')].map((b) => b.textContent.trim()).filter((x) => /save|saved|ذخیره/i.test(x)))));
// and what the panel THINKS it holds: the chips with their point counts
console.log('  chips now:', JSON.stringify(await panel.evaluate(() => [...document.querySelectorAll('.event-chip')].map((c) => c.textContent.trim()))));

console.log('\n=== did the save-request even reach the worker? ===');
const log = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all);
  const events = all[keys.find((k) => /event/i.test(k)) ?? ''] ?? [];
  return {
    storageKeys: keys,
    recent: (Array.isArray(events) ? events : []).slice(-12).map((e) => `${e.kind}:${e.automationId ?? ''}${e.reason ? '/' + e.reason : ''}`),
  };
});
console.log('  storage keys:', JSON.stringify(log.storageKeys));
console.log('  recent events:', JSON.stringify(log.recent, null, 0));

console.log('\n=== what STORAGE and the ALARM REGISTRY now hold ===');
const state = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const list = all.automations ?? [];
  const alarms = await chrome.alarms.getAll();
  return {
    count: list.length,
    automations: list.map((a) => ({
      id: a.id, name: a.name, time: `${a.schedule?.hour}:${String(a.schedule?.minute).padStart(2, '0')}:${String(a.schedule?.second).padStart(2, '0')}${a.schedule?.ms ? '.' + a.schedule.ms : ''}`,
      steps: (a.steps ?? []).length,
      enabled: a.enabled,
      selectors: (a.steps ?? []).map((s) => s.finder?.selector ?? s.finder?.id ?? '—'),
    })),
    alarms: alarms.map((a) => ({ name: a.name, at: a.scheduledTime })),
  };
});
console.log('  automations stored:', state.count);
for (const a of state.automations) console.log(`    ${a.id.padEnd(12)} ${a.time.padEnd(14)} steps=${a.steps} sel=${JSON.stringify(a.selectors)}`);
console.log('  alarms armed:', state.alarms.length);
for (const a of state.alarms) console.log(`    ${a.name}  at ${new Date(a.at).toISOString()}`);

await ctx.close();
process.exit(0);
