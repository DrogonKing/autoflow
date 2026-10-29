#!/usr/bin/env node
/**
 * Why does clicking the toolbar icon do nothing?
 *
 * The user reports it on a real Chrome. Theory is not good enough here, so this loads the built extension in a
 * real Chromium and asks the browser directly:
 *
 *   1. Does the service worker start at all, and does its console contain errors?
 *   2. Is `chrome.sidePanel` present, and does `setPanelBehavior` actually resolve?
 *      (The implementation calls it inside `.catch(() => {})` and returns `true` either way, so a silent
 *       failure is indistinguishable from success in the shipped code. This measures the real outcome.)
 *   3. Does the side panel open when it is opened the way the click handler opens it?
 *   4. Does the panel's document actually render, or is it blank?
 *
 * Each answer is a measurement, printed with what was asked and what came back.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');

if (!existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('no dist/manifest.json - run `node scripts/build.mjs` first');
  process.exit(1);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}`);
  if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ').slice(0, 700)}`);
};

// Prefer the Chromium already installed on this machine, exactly as browser-test.mjs does. Playwright's own
// download is not installed here and the shared cache is deliberately preserved, so the bundled path would
// fail with "Executable doesn't exist".
const explicitChromium = process.env.AUTOFLOW_CHROMIUM ||
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const launchOptions = {
  headless: false,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
};
if (existsSync(explicitChromium)) {
  launchOptions.executablePath = explicitChromium;
} else {
  console.error(`no chromium at ${explicitChromium} - set AUTOFLOW_CHROMIUM to a Chrome binary`);
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext('', launchOptions);

// ---- 1. does the worker start, and is its console clean?
let worker = null;
{
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !worker) {
    worker = ctx.serviceWorkers()[0] ?? null;
    if (!worker) await new Promise((r) => setTimeout(r, 250));
  }
}
if (!worker) {
  check('the service worker starts', false, 'it never appeared within 25s');
  await ctx.close();
  process.exit(1);
}
check('the service worker starts', true, worker.url());

const consoleErrors = [];
worker.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
const pageErrors = [];
worker.on('pageerror', (e) => pageErrors.push(String(e)));

const extensionId = new URL(worker.url()).host;

// ---- 2. is sidePanel present, and does setPanelBehavior really resolve?
console.log('\n--- sidePanel API, asked from inside the worker ---');
const api = await worker.evaluate(async () => {
  const out = {
    hasChrome: typeof chrome !== 'undefined',
    hasSidePanel: typeof chrome?.sidePanel !== 'undefined',
    hasSidePanelPermission: false,
    hasSetPanelBehavior: typeof chrome?.sidePanel?.setPanelBehavior === 'function',
    hasOpen: typeof chrome?.sidePanel?.open === 'function',
    hasAction: typeof chrome?.action !== 'undefined',
    hasSidebarAction: typeof chrome?.sidebarAction !== 'undefined',
    manifestVersion: chrome?.runtime?.getManifest?.()?.manifest_version,
    version: chrome?.runtime?.getManifest?.()?.version,
  };
  try {
    out.hasSidePanelPermission = await chrome.permissions.contains({ permissions: ['sidePanel'] });
  } catch (e) {
    out.permissionCheckError = String(e);
  }
  // the real question: does setPanelBehavior RESOLVE, or reject? the shipped code swallows this.
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    out.setPanelBehavior = 'resolved';
  } catch (e) {
    out.setPanelBehavior = `REJECTED: ${e?.message || e}`;
  }
  // and can it read the behavior back?
  try {
    out.getPanelBehavior = JSON.stringify(await chrome.sidePanel.getPanelBehavior());
  } catch (e) {
    out.getPanelBehavior = `error: ${e?.message || e}`;
  }
  try {
    out.getOptions = JSON.stringify(await chrome.sidePanel.getOptions({}));
  } catch (e) {
    out.getOptions = `error: ${e?.message || e}`;
  }
  return out;
});
console.log(JSON.stringify(api, null, 2));

check('chrome.sidePanel exists', api.hasSidePanel === true);
check('the sidePanel permission is granted', api.hasSidePanelPermission === true, JSON.stringify(api.hasSidePanelPermission));
check('setPanelBehavior resolves', api.setPanelBehavior === 'resolved', api.setPanelBehavior);
check('openPanelOnActionClick is really true afterwards',
  String(api.getPanelBehavior || '').includes('true'), api.getPanelBehavior);
check('side_panel options are readable', !String(api.getOptions).startsWith('error'), api.getOptions);

// ---- 3. does the panel document exist and render?
console.log('\n--- the panel document itself ---');
const panelUrl = `chrome-extension://${extensionId}/panel.html`;
const panel = await ctx.newPage();
const panelErrors = [];
panel.on('pageerror', (e) => panelErrors.push(String(e)));
panel.on('console', (m) => { if (m.type() === 'error') panelErrors.push(m.text()); });
let panelLoaded = false;
try {
  const resp = await panel.goto(panelUrl, { timeout: 15_000 });
  panelLoaded = !!resp;
  await panel.waitForTimeout(1500);
} catch (e) {
  check('panel.html loads', false, String(e).slice(0, 300));
}
if (panelLoaded) {
  const info = await panel.evaluate(() => ({
    title: document.title,
    bodyLength: document.body?.innerHTML?.length ?? 0,
    text: (document.body?.innerText || '').slice(0, 300),
    hasRoot: !!document.querySelector('#app, #root, body > *'),
    childCount: document.body?.children?.length ?? 0,
    hasAutoflowMarker: !!document.documentElement.getAttribute('data-autoflow'),
  }));
  check('panel.html loads', true, panelUrl);
  check('the panel actually renders something', info.childCount > 0 && info.bodyLength > 500,
    `title=${JSON.stringify(info.title)} children=${info.childCount} html=${info.bodyLength} chars`);
  console.log(`        visible text: ${JSON.stringify(info.text.slice(0, 200))}`);
}

// ---- 4. does the message channel from the panel to the worker work?
console.log('\n--- panel -> worker messaging ---');
const msg = await panel.evaluate(async () => {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'list-automations' });
    return { ok: true, reply: JSON.stringify(r).slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
check('the panel can reach the worker', msg.ok === true, msg.ok ? msg.reply : msg.error);

// ---- 5. what did the worker log?
console.log('\n--- console output ---');
check('no worker console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join('\n'));
check('no worker page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join('\n'));
check('no panel console errors', panelErrors.length === 0, panelErrors.slice(0, 8).join('\n'));

await ctx.close();

const failed = results.filter((r) => r.ok === false);
console.log('\n' + '='.repeat(70));
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);
