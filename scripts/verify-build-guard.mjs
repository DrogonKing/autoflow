#!/usr/bin/env node
/**
 * Verify the two things that were broken, in real browsers.
 *
 * What is being tested, and why each check is shaped the way it is:
 *
 *  1. THE MISMATCH BANNER. Loading the Firefox build in Chrome must produce a visible sentence explaining
 *     it. This is the control that matters, because on that build there is no service worker - so the banner
 *     has to work with no help from the background script. The check therefore looks for the banner in the
 *     rendered DOM of a plain extension page, not for a message.
 *
 *  2. NO ERROR BADGE ON THE CORRECT BUILD. The measured cause was `sidePanel.open()` rejecting after the
 *     browser had already opened the panel itself. Chromium only exposes the badge text to the extension via
 *     `chrome.action.getBadgeText`, so the check reads it back rather than screenshotting the toolbar.
 *
 * Both are run against the built archives unpacked from their zips, so what is tested is what a user gets.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForUnpackedExtensionId } from './lib/extension-id.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASE = path.join(ROOT, 'release');
const CHROME = process.env.AUTOFLOW_CHROMIUM ||
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

/** Unpack an archive into a temp dir - what a user does by hand, done the same way. */
function unpack(zipName) {
  const dest = mkdtempSync(path.join(os.tmpdir(), 'autoflow-unpack-'));
  execFileSync('python3', ['-c', `
import zipfile, sys
zipfile.ZipFile(${JSON.stringify(path.join(RELEASE, zipName))}).extractall(${JSON.stringify(dest)})
`]);
  return dest;
}

/**
 * Launch a FRESH profile each time, inside the workspace.
 *
 * A persistent profile keeps extension state between runs, and the toolbar bug being tested here only showed
 * up on a first install - `onInstalled` had not taken effect yet. Reusing a warm profile would have hidden it.
 * Being inside the workspace also means a CI runner can always write it.
 */
async function loadIn(buildDir, { headless = true } = {}) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'autoflow-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless,
    executablePath: existsSync(CHROME) ? CHROME : undefined,
    args: [
      `--disable-extensions-except=${buildDir}`,
      `--load-extension=${buildDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  ctx.__profile = profile;
  return ctx;
}

/**
 * The extension's id, read from the profile rather than from `chrome://extensions`.
 *
 * That page works in this machine's desktop Chrome and fails on the Chromium Playwright installs on CI:
 *   page.goto: net::ERR_INVALID_URL at chrome://extensions
 * Reading the profile works on both.
 */
async function extensionIdFor(ctx, buildDir) {
  const found = await waitForUnpackedExtensionId(ctx.__profile, buildDir);
  return found?.id ?? null;
}

/** Find OUR extension id, not a Chrome component extension's. */
async function ourExtension(ctx) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const w of ctx.serviceWorkers()) {
      const id = new URL(w.url()).host;
      if (ctx.pages().some((p) => p.url().includes(id))) return { id, worker: w };
      // ask the worker for its manifest name
      try {
        const name = await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? '');
        if (/autoflow/i.test(name)) return { id, worker: w };
      } catch { /* not ours */ }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// ================================================================================================
// 1. the Firefox archive, loaded into CHROME: the mismatched build
// ================================================================================================
console.log('\n' + '='.repeat(74));
console.log('1. the FIREFOX archive loaded into CHROME (the reported failure)');
console.log('='.repeat(74));

const ffDir = unpack('autoflow-firefox.zip');
console.log(`  unpacked to ${ffDir}`);
console.log(`  contents: ${execFileSync('ls', [ffDir]).toString().trim().split('\n').join(', ')}`);

{
  const ctx = await loadIn(ffDir);
  // This build has NO service worker, so the id cannot come from one. It is read from the profile, which also
  // proves Chrome accepted and registered the extension.
  const id = await extensionIdFor(ctx, ffDir);
  check('Chrome accepted the Firefox build', !!id,
    id ? `extension id ${id} (from the profile, and no service worker, as expected)` : 'not registered');

  if (id) {
    const p = await ctx.newPage();
    let banner = null;
    try {
      await p.goto(`chrome-extension://${id}/options.html`, { timeout: 15_000 });
      await p.waitForTimeout(1200);
      banner = await p.evaluate(() => {
        const el = document.querySelector('[role="alert"]');
        return el ? { text: el.innerText.replace(/\s+/g, ' ').trim(), bg: getComputedStyle(el).backgroundColor } : null;
      });
    } catch (e) {
      banner = { error: String(e).slice(0, 200) };
    }
    check('a visible banner explains the mismatch', !!banner?.text,
      banner?.text ? `"${banner.text}"` : JSON.stringify(banner));
    check('the banner names the file to download instead',
      /autoflow-chrome\.zip/.test(banner?.text || ''), banner?.text || '');
  }

  // and the toolbar button on this build: the browser exposes the badge the user sees
  const badge = await (async () => {
    const w = ctx.serviceWorkers().find((x) => /background/.test(x.url()));
    if (!w) return 'no service worker on this build (expected)';
    return 'unexpected service worker';
  })();
  console.log(`  toolbar badge source : ${badge}`);
  await ctx.close();
}
rmSync(ffDir, { recursive: true, force: true });

// ================================================================================================
// 2. the Chrome archive in Chrome: the correct pairing, and the badge must be empty
// ================================================================================================
console.log('\n' + '='.repeat(74));
console.log('2. the CHROME archive loaded into CHROME (the correct pairing)');
console.log('='.repeat(74));

const crDir = unpack('autoflow-chrome.zip');
console.log(`  unpacked to ${crDir}`);
console.log(`  contents: ${execFileSync('ls', [crDir]).toString().trim().split('\n').join(', ')}`);

{
  const ctx = await loadIn(crDir);
  const found = await ourExtension(ctx);
  if (found && !found.id) found.id = await extensionIdFor(ctx, crDir);
  check('the service worker runs', !!found?.worker, found?.worker?.url() ?? 'no worker');

  if (found?.worker) {
    const state = await found.worker.evaluate(async () => {
      const out = {};
      try {
        out.badge = await chrome.action.getBadgeText({});
      } catch (e) {
        out.badge = `error: ${e?.message || e}`;
      }
      try {
        out.behavior = JSON.stringify(await chrome.sidePanel.getPanelBehavior());
      } catch (e) {
        out.behavior = `error: ${e?.message || e}`;
      }
      try {
        out.options = JSON.stringify(await chrome.sidePanel.getOptions({}));
      } catch (e) {
        out.options = `error: ${e?.message || e}`;
      }
      return out;
    });
    console.log(`  badge text          : ${JSON.stringify(state.badge)}`);
    console.log(`  panel behavior      : ${state.behavior}`);
    console.log(`  panel options       : ${state.options}`);
    check('the toolbar badge is EMPTY (no error shown)', state.badge === '',
      `badge=${JSON.stringify(state.badge)}`);
    check('openPanelOnActionClick is on', /openPanelOnActionClick"?\s*:\s*true/.test(state.behavior),
      state.behavior);
  }

  // and the correct build's options page must NOT show the mismatch banner
  if (found?.id) {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${found.id}/options.html`);
    await p.waitForTimeout(1000);
    const banner = await p.evaluate(() => document.querySelector('[role="alert"]')?.innerText ?? null);
    check('the correct build shows NO mismatch banner', banner === null, banner || 'none, as expected');
  }

  await ctx.close();
}
rmSync(crDir, { recursive: true, force: true });

console.log('\n' + '='.repeat(74));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);
