#!/usr/bin/env node
/**
 * Definitive probe of the two failures, on the exact build that fails.
 *
 * Guessing has been wrong twice, so this reports raw facts:
 *
 *   A. On the FIREFOX build loaded in Chrome, what does `chrome.runtime.getManifest()` actually return?
 *      The banner's decision depends on `background.service_worker` being absent, which assumed manifest
 *      normalisation does not happen. Print it.
 *   B. Does build-banner.js execute in that page at all? Look for a sentinel the script sets, and for
 *      whatever it threw.
 *   C. Worker console, captured from process start, so the `ensureClickOpensPanel` warn/info is visible.
 *      `openPanelOnActionClick` is still false, so that call is failing and it now says why.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM ||
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const RELEASE = path.join(ROOT, 'release');

function unpack(zipName) {
  const dest = mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  execFileSync('python3', ['-c',
    `import zipfile;zipfile.ZipFile(${JSON.stringify(path.join(RELEASE, zipName))}).extractall(${JSON.stringify(dest)})`]);
  return dest;
}

async function probe(label, dir) {
  console.log(`\n${'='.repeat(74)}\n${label}   ${dir}\n${'='.repeat(74)}`);
  const ctx = await chromium.launchPersistentContext('', {
    headless: true,
    executablePath: existsSync(CHROME) ? CHROME : undefined,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--no-sandbox', '--disable-dev-shm-usage'],
  });

  // capture worker console from the very start, via CDP
  const workerLogs = [];
  const cdp = await ctx.newCDPSession(await ctx.newPage());
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  cdp.on('Target.targetCreated', async ({ targetInfo }) => {
    if (!/service_worker/.test(targetInfo.type)) return;
    try {
      const s = await ctx.newCDPSession(await ctx.newPage());
      void s;
    } catch { /* ignore */ }
  });
  // simpler and reliable: attach to whatever worker appears and listen
  const attach = async () => {
    for (const w of ctx.serviceWorkers()) {
      if (!w.__hooked) {
        w.__hooked = true;
        w.on('console', (m) => workerLogs.push(`[${m.type()}] ${m.text()}`));
        w.on('pageerror', (e) => workerLogs.push(`[pageerror] ${String(e)}`));
      }
    }
  };

  // find the extension id: try the worker, else chrome://extensions
  let id = null;
  let fromWorker = false;
  {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await attach();
      for (const w of ctx.serviceWorkers()) {
        try {
          const name = await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? '');
          if (/autoflow/i.test(name)) { id = new URL(w.url()).host; fromWorker = true; break; }
        } catch { /* not ours */ }
      }
      if (id) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!id) {
    const p = await ctx.newPage();
    await p.goto('chrome://extensions');
    await p.waitForTimeout(2500);
    id = await p.evaluate(() => {
      const mgr = document.querySelector('extensions-manager');
      const list = mgr?.shadowRoot?.querySelector('extensions-item-list');
      for (const it of list?.shadowRoot?.querySelectorAll('extensions-item') ?? []) {
        if (/autoflow/i.test(it.shadowRoot?.querySelector('#name')?.textContent ?? '')) return it.getAttribute('id');
      }
      return null;
    });
  }
  console.log(`extension id : ${id}   (service worker present: ${fromWorker})`);
  if (!id) { await ctx.close(); return; }

  const page = await ctx.newPage();
  const pageLogs = [];
  page.on('console', (m) => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => pageLogs.push(`[pageerror] ${String(e)}`));
  page.on('requestfailed', (r) => pageLogs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  const responses = [];
  page.on('response', (r) => responses.push(`${r.status()} ${r.url()}`));

  await page.goto(`chrome-extension://${id}/options.html`);
  await page.waitForTimeout(1500);

  const facts = await page.evaluate(() => {
    const out = {};
    try {
      const m = chrome.runtime.getManifest();
      out.manifestBackground = JSON.stringify(m.background);
      out.manifestSidePanel = JSON.stringify(m.side_panel) ?? 'undefined';
      out.manifestSidebarAction = JSON.stringify(m.sidebar_action) ?? 'undefined';
      out.manifestVersion = m.manifest_version;
      out.buildIsChromiumComputed = !!(m.background && m.background.service_worker);
    } catch (e) { out.manifestError = String(e); }
    out.hasChrome = typeof chrome !== 'undefined';
    out.hasRuntime = typeof chrome?.runtime !== 'undefined';
    out.hasSidePanelApi = typeof chrome?.sidePanel !== 'undefined';
    out.hasSidebarActionApi = typeof chrome?.sidebarAction !== 'undefined';
    out.browserIsChromiumComputed = typeof chrome?.sidePanel !== 'undefined';
    out.alertsInDom = document.querySelectorAll('[role="alert"]').length;
    out.scriptsInDom = [...document.querySelectorAll('script')].map((s) => s.src || '(inline)');
    out.htmlHeadLength = document.head?.innerHTML?.length ?? -1;
    return out;
  });

  console.log('\nwhat the page can see:');
  console.log(JSON.stringify(facts, null, 2));
  console.log(`\nwould the banner warn?  ${facts.buildIsChromiumComputed !== facts.browserIsChromiumComputed}`);
  console.log('\npage console/network:');
  console.log(pageLogs.length ? pageLogs.map((l) => '  ' + l).join('\n') : '  (nothing)');
  console.log('responses:');
  console.log(responses.map((r) => '  ' + r).join('\n'));
  console.log('\nworker console:');
  await attach();
  console.log(workerLogs.length ? workerLogs.map((l) => '  ' + l).join('\n') : '  (nothing captured)');

  // and ask the worker directly what it thinks
  const w = ctx.serviceWorkers().find((x) => /background/.test(x.url()));
  if (w) {
    const st = await w.evaluate(async () => {
      const o = {};
      try { o.behavior = JSON.stringify(await chrome.sidePanel.getPanelBehavior()); } catch (e) { o.behavior = String(e); }
      try {
        o.sidePanelExists = typeof chrome.sidePanel !== 'undefined';
        o.setPanelBehaviorIsFn = typeof chrome.sidePanel?.setPanelBehavior === 'function';
      } catch (e) { o.err = String(e); }
      return o;
    });
    console.log('\nworker state: ' + JSON.stringify(st));
  }

  await ctx.close();
}

const ff = unpack('autoflow-firefox.zip');
await probe('FIREFOX archive in CHROME', ff);
const cr = unpack('autoflow-chrome.zip');
await probe('CHROME archive in CHROME', cr);
