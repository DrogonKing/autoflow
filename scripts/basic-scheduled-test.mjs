#!/usr/bin/env node
/**
 * THE USER'S EXACT CASE: a Basic automation, no URL pattern, scheduled, left alone.
 *
 * From the 1.19.0 export:
 *
 *     runs:  basic  step-error  steps=0  ERROR: this automation has no URL pattern, so a scheduled run has no safe tab
 *
 * So this drives the same sequence: pick an element in a real page (which is what teaches the extension where the page
 * is), save the automation with `urls: []` exactly as the Basic form does, arm it for a second a few seconds away, then
 * WAIT. Run now is never pressed. The page must show the click.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIM = path.join(ROOT, 'tools/sim/index.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const profile = autoCleanup(mkdtempSync(path.join(tmpdir(), 'af-basic-')));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [
    `--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`,
    '--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ],
});

let worker = null;
for (let i = 0; i < 80 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 250));
}
if (!worker) { console.log('no worker'); process.exit(1); }
const extId = new URL(worker.url()).host;
const bridge = await ctx.newPage();
await bridge.goto(`chrome-extension://${extId}/options.html`);

const page = await ctx.newPage();
await page.goto(`file://${SIM}`);
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null, null, { timeout: 15000 });
const pageUrl = page.url();

console.log('\n--- 1. a Basic automation: no URL pattern, exactly as the form produces ---');
const saved = await bridge.evaluate(async ({ pageUrl }) => {
  /**
   * What the user does first: PICK an element, for a named automation.
   *
   * The panel's per-step Pick button sends `automationId`, because a Basic automation has no URL pattern and a scheduled
   * run needs a page - and the page is known only while the pick is happening. Without the id, nothing can be recorded
   * against it.
   */
  const picked = await chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === pageUrl));
  await chrome.runtime.sendMessage({ type: 'pick-element', tabId: picked.id, automationId: 'basic' });
  return { pickedTab: picked.id, url: pageUrl };
}, { pageUrl });
check('the page the pick will come from is known', Number.isInteger(saved.pickedTab), JSON.stringify(saved));

// the user clicks a pad in the page: the picker reports it back through the worker
await page.evaluate(() => {
  // the picker is armed by the message above; a real click lands on a pad and the content script records it
});
await page.mouse.click(140, 380);           // a pad, wherever it is - the finder records what was hit
await new Promise((r) => setTimeout(r, 700));

const state = await bridge.evaluate(async () => {
  // `get-settings` answers { ok, settings } - reading it as the settings object itself reported null while the record
  // existed, which is the same shape mistake that made `list-runs` look empty earlier
  const res = await chrome.runtime.sendMessage({ type: 'get-settings' });
  const s = res?.settings ?? res ?? {};
  return { lastPickPages: s.lastPickPages ?? null, settings: Object.keys(s) };
});
console.log(`  lastPickPages: ${JSON.stringify(state.lastPickPages)}`);
check('the pick taught the extension which page this is', Boolean(state.lastPickPages && Object.keys(state.lastPickPages).length),
  JSON.stringify(state.lastPickPages));

console.log('\n--- 2. save it with urls: [], schedule it, and DO NOT press Run now ---');
const target = new Date(Math.ceil((Date.now() + 15000) / 1000) * 1000);
const hh = target.getHours(), mm = target.getMinutes(), ss = target.getSeconds();
const armed = await bridge.evaluate(async ({ hh, mm, ss }) => {
  await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
    id: 'basic', name: 'Timed click', enabled: true,
    urls: [],                                  // <-- exactly what the Basic form stores
    steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#pad2' } }],
    schedule: { kind: 'daily', hour: hh, minute: mm, second: ss },
    options: { stepDelayMs: 60, stepRetries: 2, maxRunMs: 30 * 60_000 },
  } });
  const r = await chrome.runtime.sendMessage({ type: 'schedule-one', automationId: 'basic' });
  return r;
}, { hh, mm, ss });
console.log(`  target ${target.toLocaleTimeString()}  armed: ${JSON.stringify(armed)}`);
check('the alarm is armed for the target', armed?.scheduled === true, JSON.stringify(armed));

console.log('\n--- 3. wait, without touching anything ---');
const before = await page.evaluate(() => (window.__clicks ?? []).length);
while (Date.now() < target.getTime() + 12000) await new Promise((r) => setTimeout(r, 400));
const after = await page.evaluate(() => ({
  n: (window.__clicks ?? []).length,
  targets: (window.__clicks ?? []).map((e) => e.target),
  pad2: document.querySelector('#pad2 [data-count]')?.textContent ?? null,
}));
console.log(`  clicks before=${before} after=${after.n}  pad2 count=${after.pad2}`);

const runs = await bridge.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'list-runs' });
  return Array.isArray(r?.runs) ? r.runs : [];
});
console.log('  runs recorded:');
for (const r of runs.slice(0, 3)) {
  console.log(`    ${r.automationId ?? r.id}  ${r.reason}  steps=${r.steps}  ${r.error ? 'ERROR: ' + r.error.message : ''}`);
}

check('the scheduled run did NOT fail for lack of a tab', !runs.some((r) => /no URL pattern|no safe tab|never had an element/i.test(r.error?.message ?? '')),
  runs.map((r) => r.error?.message ?? '(no error)').slice(0, 2).join(' | '));
check('a run happened at all', runs.length > 0, `${runs.length} run(s)`);
check('the run finished rather than erroring', runs.some((r) => r.reason === 'finished'), runs.map((r) => r.reason).join(','));
check('and the page shows the click', after.n > before, `${before} -> ${after.n}`);
check('on the target the automation names', after.targets.includes('نقطه ۲'), JSON.stringify(after.targets));
check('pad2 counted it once', after.pad2 === '1', String(after.pad2));

const passed = results.filter((r) => r.ok === true).length;
console.log(`\n${'='.repeat(70)}\n${passed}/${results.length} checks passed`);
for (const r of results.filter((r) => r.ok !== true)) console.log(`  FAIL ${r.name}  ${r.detail ?? ''}`);

await ctx.close();
process.exit(passed === results.length ? 0 : 1);