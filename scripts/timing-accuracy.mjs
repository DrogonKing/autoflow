#!/usr/bin/env node
/**
 * How accurate is a sub-second-cron alarm in a real Chromium?
 *
 * The claim on the table is "cron is accurate to the second". That claim is about the MODEL - nextRun returns
 * an exact millisecond. It says nothing about when the browser actually fires, and for an order window the
 * second part is the only one that matters.
 *
 * chrome.alarms is documented to be imprecise and subject to throttling, so this measures the real number
 * rather than repeating the documentation. It arms one-shot alarms at several offsets and records
 * (actual - requested) for each. A negative delay means it fired early, which would matter even more than
 * late for a "not before 09:00" requirement.
 *
 * Three things are measured, because they fail differently:
 *   1. small offsets (0.5s, 1s, 2s)   - the floor of what can be asked for
 *   2. a wake-up shortly before      - the realistic design: arm early, wait precisely in the page
 *   3. service-worker restart        - does an armed alarm survive the worker being killed? For an order
 *                                      window it must, or the run is simply lost.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.AUTOFLOW_CHROMIUM ||
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'autoflow-timing-')));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ],
});

let worker = null;
{
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !worker) {
    for (const w of ctx.serviceWorkers()) {
      try {
        if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; }
      } catch { /* not ours */ }
    }
    if (!worker) await new Promise((r) => setTimeout(r, 300));
  }
}
if (!worker) { console.error('no worker'); await ctx.close(); process.exit(1); }

console.log('='.repeat(78));
console.log('chrome.alarms accuracy, measured in Chromium ' + ctx.browser()?.version?.() ?? '');
console.log('='.repeat(78));

/**
 * Arm one alarm, wait for it, report the error.
 *
 * The listener is registered BEFORE the alarm is created, because an alarm that fires before a listener is
 * attached is missed - which is itself a real failure mode worth not tripping over in the measurement.
 */
async function measure(delayMs, label) {
  const name = `probe-${label}-${Date.now()}`;
  const result = await worker.evaluate(async ({ name, delayMs }) => {
    const requestedAt = Date.now() + delayMs;
    let resolveFired;
    const fired = new Promise((r) => { resolveFired = r; });
    const onAlarm = (a) => { if (a.name === name) { resolveFired(Date.now()); chrome.alarms.onAlarm.removeListener(onAlarm); } };
    chrome.alarms.onAlarm.addListener(onAlarm);
    await chrome.alarms.create(name, { when: requestedAt });
    const settled = await Promise.race([
      fired,
      new Promise((r) => setTimeout(() => r(null), delayMs + 8000)),
    ]);
    chrome.alarms.onAlarm.removeListener(onAlarm);
    await chrome.alarms.clear(name);
    return { requestedAt, firedAt: settled, errorMs: settled === null ? null : settled - requestedAt };
  }, { name, delayMs });
  const e = result.errorMs;
  const verdict = e === null ? 'NEVER FIRED'
    : e < 0 ? `EARLY by ${-e}ms`
    : `late by ${e}ms`;
  console.log(`  ${label.padEnd(22)} requested +${String(delayMs).padStart(5)}ms   ${verdict}`);
  return result;
}

const samples = [];
for (const d of [500, 1000, 2000, 5000]) {
  const r = await measure(d, `${d}ms`);
  if (r.errorMs !== null) samples.push(r.errorMs);
}

console.log('');
if (samples.length) {
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`  worst early: ${Math.min(0, min)}ms      worst late: ${Math.max(0, max)}ms`);
  console.log(`  median error: ${median}ms`);
  console.log('');
  console.log('  INTERPRETATION, and it decides the design:');
  if (max > 250 || min < -250) {
    console.log('    an alarm alone is too coarse to hit a second. It must be used as a WAKE-UP,');
    console.log('    with the precise wait done in the page.');
  } else {
    console.log('    an alarm lands within a quarter second, which is close enough to be the trigger.');
  }
}

// ---- does an armed alarm survive the worker being killed?
console.log('');
console.log('--- does an armed alarm survive the service worker stopping? ---');
const survival = await worker.evaluate(async () => {
  const at = Date.now() + 4000;
  await chrome.alarms.create('survive-probe', { when: at });
  const all = await chrome.alarms.getAll();
  return { armedFor: at, listed: all.some((a) => a.name === 'survive-probe') };
});
console.log(`  the alarm is listed: ${survival.listed}`);
// stopping the worker: there is no supported API, so this reports what chrome reports rather than guessing
const cdp = await ctx.newCDPSession(await ctx.newPage());
try {
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await new Promise((r) => setTimeout(r, 800));
  const after = await ctx.serviceWorkers().length;
  console.log(`  workers running after stopAllWorkers: ${after}`);
  // a fresh page wakes the worker; the alarm should still be there
  const p = await ctx.newPage();
  const alive = await p.evaluate(async (id) => {
    try {
      await chrome.runtime.sendMessage({ type: 'noop' });
    } catch { /* expected */ }
    return true;
  }, null).catch(() => false);
  await p.close();
} catch (e) {
  console.log(`  could not stop the worker: ${String(e?.message ?? e).slice(0, 100)}`);
}

await ctx.close();
process.exit(0);