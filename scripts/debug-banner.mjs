#!/usr/bin/env node
/**
 * Ask the browser WHY the two fixes are not taking effect, instead of guessing again.
 *
 * Two failures persist and both were assumed to be fixed:
 *   - the mismatch banner does not appear
 *   - openPanelOnActionClick is still false after install
 *
 * So this prints the evidence rather than a theory:
 *   1. is the banner script ACTUALLY in the built options.html, and does it throw when it runs?
 *   2. what does chrome.runtime.getManifest().background look like from inside the page?
 *   3. does onInstalled fire at all, and what does enableOpenOnClick return?
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM ||
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

// ---- 1. is the script in the built file at all?
for (const f of ['dist/options.html', 'dist-firefox/options.html']) {
  const t = await readFile(path.join(ROOT, f), 'utf8');
  const hasScript = /getManifest/.test(t);
  const idx = t.indexOf('<head>');
  console.log(`${f}: ${t.length} bytes, banner script present: ${hasScript}`);
  console.log(`   first 200 chars after <head>: ${JSON.stringify(t.slice(idx, idx + 200))}`);
}

// ---- 2. run it and see
const DIST = path.join(ROOT, 'dist');
const ctx = await chromium.launchPersistentContext('', {
  headless: true,
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox', '--disable-dev-shm-usage'],
});

let worker = null;
{
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !worker) {
    for (const w of ctx.serviceWorkers()) {
      try {
        const name = await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? '');
        if (/autoflow/i.test(name)) { worker = w; break; }
      } catch { /* not ours */ }
    }
    if (!worker) await new Promise((r) => setTimeout(r, 300));
  }
}
console.log(`\nworker: ${worker ? worker.url() : 'NONE'}`);
const id = worker ? new URL(worker.url()).host : null;

if (id) {
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`chrome-extension://${id}/options.html`);
  await page.waitForTimeout(1200);

  const probe = await page.evaluate(() => {
    const out = {};
    try {
      const m = chrome.runtime.getManifest();
      out.background = JSON.stringify(m.background);
      out.hasServiceWorkerKey = !!(m.background && m.background.service_worker);
      out.hasSidePanelKey = !!m.side_panel;
    } catch (e) { out.manifestError = String(e); }
    out.hasSidePanelApi = typeof chrome.sidePanel !== 'undefined';
    out.alerts = document.querySelectorAll('[role="alert"]').length;
    // run the discriminator BY HAND and report what it decides
    try {
      const m = chrome.runtime.getManifest();
      const buildIsChromium = !!(m.background && m.background.service_worker);
      const browserIsChromium = typeof chrome.sidePanel !== 'undefined';
      out.decision = { buildIsChromium, browserIsChromium, wouldWarn: buildIsChromium !== browserIsChromium };
    } catch (e) { out.decisionError = String(e); }
    return out;
  });
  console.log('\nfrom inside the extension page:');
  console.log(JSON.stringify(probe, null, 2));
  console.log(`page errors: ${errs.length ? errs.join('\n  ') : 'none'}`);

  // ---- 3. what happened at install?
  const install = await worker.evaluate(async () => {
    const out = {};
    try {
      out.behaviorBefore = JSON.stringify(await chrome.sidePanel.getPanelBehavior());
    } catch (e) { out.behaviorBefore = String(e); }
    // call the same thing onInstalled calls, and report the real outcome
    try {
      const sp = chrome.sidePanel;
      out.hasSetPanelBehavior = typeof sp?.setPanelBehavior === 'function';
      await sp.setPanelBehavior({ openPanelOnActionClick: true });
      out.manualSet = 'resolved';
    } catch (e) { out.manualSet = `REJECTED: ${e?.message || e}`; }
    try {
      out.behaviorAfter = JSON.stringify(await chrome.sidePanel.getPanelBehavior());
    } catch (e) { out.behaviorAfter = String(e); }
    return out;
  });
  console.log('\nfrom inside the worker:');
  console.log(JSON.stringify(install, null, 2));
}

await ctx.close();
