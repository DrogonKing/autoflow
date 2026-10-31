#!/usr/bin/env node
/**
 * Can the test field be opened as a plain FILE, with no server at all?
 *
 * This matters because the recommended `npm run sim` serves the page from the machine that runs it, and the user's
 * browser is on a different computer. So the file has to work standalone.
 *
 * Chromium refuses to inject a content script into `file://` unless the extension has been granted "Allow access
 * to file URLs" - a per-extension toggle, off by default. The flag `--allow-file-access-from-files` is not the
 * same thing; the one that matters for extensions is `--extensions-on-chrome-urls`-adjacent and is controlled
 * per extension. Playwright's `--disable-extensions-file-access-check` is the equivalent of that toggle.
 *
 * So this measures the three states honestly rather than assuming:
 *   1. no flag         -> does injection fail, and does the page still work by hand?
 *   2. with the flag   -> does the extension inject, and does a picked click get logged?
 */
import { existsSync, mkdtempSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const SIM = path.join(ROOT, 'tools', 'sim', 'index.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

// copy the file somewhere with no spaces, which is what a user's Downloads folder looks like
const tmp = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-file-')));
const local = path.join(tmp, 'autofook-test-field.html');
copyFileSync(SIM, local);
const fileUrl = pathToFileURL(local).href;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

async function open({ allowFileUrls }) {
  const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-prof-')));
  const args = [
    `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
    '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ];
  // the equivalent of the user ticking "Allow access to file URLs"
  if (allowFileUrls) args.push('--disable-extensions-file-access-check');

  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined, args,
  });
  const page = await ctx.newPage();
  await page.goto(fileUrl);
  await page.waitForTimeout(1500);
  return { ctx, page };
}

console.log('='.repeat(78));
console.log(`the file: ${fileUrl}`);
console.log(`size: ${(await import('node:fs')).statSync(local).size} bytes, self-contained`);
console.log('='.repeat(78));

console.log('\n--- 1. opened as a file, WITHOUT "Allow access to file URLs" ---');
{
  const { ctx, page } = await open({ allowFileUrls: false });
  const state = await page.evaluate(() => ({
    clock: document.getElementById('clock')?.textContent,
    pads: document.querySelectorAll('.pad[data-target]').length,
    sames: document.querySelectorAll('.same[data-target]').length,
    injected: document.documentElement.getAttribute('data-autoflow-content'),
  }));
  console.log(`  clock=${state.clock}  pads=${state.pads}  sames=${state.sames}  injected=${state.injected}`);
  check('the page itself works with no server at all', state.pads === 5 && state.sames === 3,
    `pads=${state.pads} sames=${state.sames}`);
  check('the hundredths clock runs', /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(state.clock ?? ''), state.clock);
  // MEASURED, not assumed. Playwright launches with --load-extension, which grants this extension file access
  // implicitly; a user who loads it through chrome://extensions does not get that until they tick "Allow access
  // to file URLs". So the honest report is which state was observed, and the docs tell the user to tick it.
  console.log(`  file access: ${state.injected === null
    ? 'NOT granted - the per-extension toggle is off'
    : 'granted for this launch (Playwright implies it with --load-extension)'}`);
  check('the page and the clock work with no server, whatever the file-access state',
    state.pads === 5 && /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(state.clock ?? ''),
    `pads=${state.pads} clock=${state.clock}`);

  // a manual click must still be recorded: the page is useful even with no extension
  await page.click('#pad3');
  await page.waitForTimeout(150);
  const log = await page.evaluate(() => window.__clicks.map((e) => ({ at: e.at, target: e.target })));
  check('a manual click is recorded with its hundredth-of-a-second time',
    log.length === 1 && /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(log[0]?.at ?? ''),
    JSON.stringify(log));
  await ctx.close();
}

console.log('\n--- 2. opened as a file, WITH "Allow access to file URLs" ---');
{
  const { ctx, page } = await open({ allowFileUrls: true });
  const injected = await page.evaluate(() => document.documentElement.getAttribute('data-autoflow-content'));
  check('the extension injects once the toggle is on', injected !== null, `marker=${injected}`);

  // and a real click through the extension is logged by the page
  let worker = null;
  for (let i = 0; i < 50 && !worker; i++) {
    for (const w of ctx.serviceWorkers()) {
      try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
    }
    if (!worker) await new Promise((r) => setTimeout(r, 300));
  }
  if (worker) {
    const bridge = await ctx.newPage();
    await bridge.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    const tabId = await bridge.evaluate(async () => (await chrome.tabs.query({}))
      .find((t) => (t.url ?? '').startsWith('file://'))?.id ?? null);
    const run = await bridge.evaluate(async ({ tabId }) => {
      await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
        id: 'file-sim', name: 'file sim', enabled: false, urls: [],
        steps: [
          { id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#pad2' } },
          { id: 's2', kind: 'click', finder: { strategy: 'css', selector: '#pad4' } },
        ],
        schedule: { kind: 'manual' }, options: { stepDelayMs: 0 },
      } });
      return chrome.runtime.sendMessage({ type: 'start-run', automationId: 'file-sim', tabId });
    }, { tabId });

    await page.waitForFunction(() => (window.__clicks?.length ?? 0) >= 2, null, { timeout: 15_000 })
      .catch(() => {});
    const log = await page.evaluate(() => window.__clicks.map((e) => ({ at: e.at, target: e.target })));
    console.log(`  log: ${JSON.stringify(log)}`);
    check('the run completed against a file:// page', run?.ok === true, JSON.stringify(run?.error ?? 'ok'));
    check('both clicks were logged with hundredths',
      log.length === 2 && log.every((e) => /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(e.at)),
      JSON.stringify(log));
    check('each landed on its own point',
      log.map((e) => e.target).join(',') === 'نقطه ۲,نقطه ۴', log.map((e) => e.target).join(','));
  } else {
    check('the service worker started', false, 'no worker');
  }
  await ctx.close();
}

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);