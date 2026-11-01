#!/usr/bin/env node
/**
 * Why does a deleted time keep its record?
 *
 * Print the save path's own view: what `storedIds` was, what `remove` came back with, and what storage holds after. Every
 * earlier attempt at this was a guess; this records the values.
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

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-del-')));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: false,
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-sandbox'],
  viewport: { width: 1280, height: 1100 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const id = new URL(sw.url()).host;
const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  PAGE ERROR:', e.message.slice(0, 200)));
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForLoadState('domcontentloaded');
await panel.waitForSelector('nav.tabs button', { timeout: 20000 });
await panel.evaluate(() => document.querySelector('nav.tabs button')?.click());
await new Promise((r) => setTimeout(r, 900));

const stored = () => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.automations ?? []).map((a) => `${a.id}@${a.schedule?.hour}:${String(a.schedule?.minute).padStart(2, '0')}`);
});
const chips = () => panel.evaluate(() => [...document.querySelectorAll('.event-chip')].map((c) => ({
  id: c.dataset.eventId, text: c.querySelector('.event-chip-open')?.textContent?.trim(),
})));
const setPoint = async (sel) => {
  await panel.evaluate((s) => {
    const inputs = [...document.querySelectorAll('main input')].filter((x) => !/time-input/.test(x.className));
    const i = inputs[inputs.length - 1];
    if (i) { i.value = s; i.dispatchEvent(new Event('change', { bubbles: true })); }
  }, sel);
  await new Promise((r) => setTimeout(r, 300));
};
const addTime = async () => {
  await panel.evaluate(() => [...document.querySelectorAll('main button')].find((x) => /New time/.test(x.textContent))?.click());
  await new Promise((r) => setTimeout(r, 700));
};

// two times, each with a point, saved
await setPoint('#a');
await addTime();
await setPoint('#b');
await new Promise((r) => setTimeout(r, 2000));
console.log('chips   :', JSON.stringify(await chips()));
console.log('stored  :', JSON.stringify(await stored()));

// instrument the messages the panel sends
await panel.evaluate(() => {
  window.__sent = [];
  const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (msg, ...rest) => {
    window.__sent.push(msg?.type + (msg?.id ? ':' + msg.id : ''));
    return orig(msg, ...rest);
  };
});

console.log('\n--- remove the first time ---');
const first = (await chips())[0];
await panel.evaluate((eid) => {
  const chip = [...document.querySelectorAll('.event-chip')].find((c) => c.dataset.eventId === eid);
  chip?.querySelector('.event-chip-remove')?.click();
}, first.id);
await new Promise((r) => setTimeout(r, 2500));

console.log('chips   :', JSON.stringify(await chips()));
console.log('stored  :', JSON.stringify(await stored()));
console.log('messages sent by the panel:', JSON.stringify(await panel.evaluate(() => window.__sent ?? [])));

const log = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return (all.diagnosticEvents ?? []).slice(-14).map((e) => `${e.kind}${e.automationId ? ':' + e.automationId : ''}`);
});
console.log('worker events:', JSON.stringify(log));

await ctx.close();
process.exit(0);