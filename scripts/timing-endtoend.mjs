#!/usr/bin/env node
/**
 * The number that actually matters: requested time -> the click landing.
 *
 * Measuring the alarm alone is not enough. Between the alarm and the click there is: worker wake-up, reading
 * the automation from storage, resolving the tab, a message round-trip to the content script, the finder, and
 * the pointer sequence. Any of those can add tens of milliseconds, and for "click at 09:00:00" the end-to-end
 * offset is the only figure worth quoting.
 *
 * So this arms a real scheduled automation whose only step is a click on a button that records
 * performance.now() when pressed, and compares that stamp with the requested wall-clock time.
 *
 * Run five times, because one sample is an anecdote and the spread is the useful part.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.AUTOFLOW_CHROMIUM ||
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

// a page with one button that stamps the moment it is pressed
const PAGE = path.join(os.tmpdir(), `autoflow-timing-page-${process.pid}.html`);
writeFileSync(PAGE, `<!doctype html><meta charset="utf-8"><title>t</title>
<button id="b" style="width:200px;height:80px">خرید</button>
<script>
  window.__pressedAt = null;
  document.getElementById('b').addEventListener('click', () => {
    window.__pressedAt = Date.now();
    document.title = 'pressed ' + window.__pressedAt;
  });
</script>`);

const profile = mkdtempSync(path.join(os.tmpdir(), 'autoflow-e2e-timing-'));
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
const extensionId = new URL(worker.url()).host;

// a bridge page, so messages are sent from the extension's own origin
const bridge = await ctx.newPage();
await bridge.goto(`chrome-extension://${extensionId}/options.html`);
const page = await ctx.newPage();
await page.goto(pathToFileURL(PAGE).href);
await page.waitForTimeout(500);

const tabId = await bridge.evaluate(async () => {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t?.id ?? null;
});

console.log('='.repeat(80));
console.log('requested time -> the click actually landing');
console.log('='.repeat(80));

const offsets = [];
for (let i = 1; i <= 5; i++) {
  const delayMs = 1500 + i * 1100;      // a different offset each run
  const requestedAt = Date.now() + delayMs;

  // reset the page, then arm a one-shot schedule on it
  await page.evaluate(() => { window.__pressedAt = null; document.title = 'armed'; });

  const armed = await bridge.evaluate(async ({ tabId, requestedAt, delayMs }) => {
    // a `once` schedule, the same shape the panel writes
    // a daily schedule at the requested time WITH a second, i.e. a precise one. `daily` is used rather than
    // `once` because `once` fires at its exact instant already and would not exercise the early wake-up.
    const when = new Date(requestedAt);
    const automation = {
      id: 'timing-probe',
      name: 'timing probe',
      enabled: true,
      steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#b' }, button: 'left' }],
      urls: [],
      schedule: {
        kind: 'daily',
        hour: when.getHours(),
        minute: when.getMinutes(),
        second: when.getSeconds(),
      },
      options: { stepDelayMs: 0 },
    };
    try {
      const saved = await chrome.runtime.sendMessage({ type: 'save-automation', automation });
      if (!saved?.ok) return { ok: false, error: saved?.error ?? 'save failed' };
      // the REAL path: arm through the scheduler, so the alarm fires early for a schedule that has a second
      const r = await chrome.runtime.sendMessage({ type: 'schedule-one', automationId: 'timing-probe' });
      return { ok: true, r, savedDelay: delayMs, tabId };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }, { tabId, requestedAt, delayMs });

  if (!armed.ok) {
    console.log(`  run ${i}: could not arm - ${armed.error}`);
    continue;
  }

  // wait for the press
  const deadline = Date.now() + delayMs + 12_000;
  let pressedAt = null;
  while (Date.now() < deadline && pressedAt === null) {
    pressedAt = await page.evaluate(() => window.__pressedAt).catch(() => null);
    if (pressedAt === null) await new Promise((r) => setTimeout(r, 25));
  }

  if (pressedAt === null) {
    console.log(`  run ${i}: NEVER PRESSED  (requested +${delayMs}ms)`);
    continue;
  }
  const off = pressedAt - requestedAt;
  offsets.push(off);
  console.log(`  run ${i}: requested +${String(delayMs).padStart(5)}ms   click landed ${off >= 0 ? 'late by ' : 'EARLY by '}${Math.abs(off)}ms`);
}

console.log('');
if (offsets.length) {
  const sorted = [...offsets].sort((a, b) => a - b);
  console.log(`  samples: ${offsets.join(', ')} ms`);
  console.log(`  min ${sorted[0]}ms   median ${sorted[Math.floor(sorted.length / 2)]}ms   max ${sorted[sorted.length - 1]}ms`);
  console.log('');
  console.log('  What this means for an order window:');
  const worst = Math.max(...offsets.map(Math.abs));
  if (worst < 100) {
    console.log(`    the click lands within ${worst}ms of the requested instant.`);
    console.log('    Setting 09:00:00 targets 09:00:00 within a tenth of a second.');
    console.log('    Being a little LATE is safe; early would be the problem, and it never is.');
  } else if (worst < 500) {
    console.log(`    the click lands within ${worst}ms. Set the time only if half a second is acceptable,`);
    console.log('    otherwise arm earlier and wait in the page.');
  } else {
    console.log(`    ${worst}ms of spread is too much to hit a second. The design has to change.`);
  }
}

await ctx.close();
process.exit(0);