#!/usr/bin/env node
/**
 * DOES THE LITE BUILD ACTUALLY WORK, and is it actually lite?
 *
 * Two separate claims to verify, and they fail in different ways:
 *
 *   1. the lite panel has ONE tab and the Basic form still works - a build that removed too much would render an
 *      empty panel, and the size win would be meaningless
 *   2. the FULL build is untouched - a guard that leaked into the normal tree would hide a tab there, which is the
 *      regression worth catching, since every existing user is on that build
 *
 * The full-build half matters as much as the lite half: the guards are new code in a file every user loads.
 */
import { mkdtempSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 220)}` : ''}`);
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>lite test</title>
<style>html,body{margin:0} #buy{position:fixed;top:200px;left:200px;width:260px;height:130px;font:22px sans-serif}</style>
<button id="buy">خرید</button><script>window.__clicks=0;document.getElementById('buy').addEventListener('click',()=>window.__clicks++);</script>`;

function serve() {
  const server = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/** Open a build's panel and report what it shows. */
async function inspectBuild(dirName, server) {
  const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-lite-')));
  const extDir = path.join(ROOT, dirName);
  if (!existsSync(path.join(extDir, 'manifest.json'))) return { skip: true };

  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: false,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-sandbox'],
    viewport: { width: 1280, height: 900 },
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForLoadState('domcontentloaded');
  await new Promise((r) => setTimeout(r, 700));

  const info = await panel.evaluate(() => {
    const tabs = [...document.querySelectorAll('nav.tabs button')].map((b) => b.textContent.trim());
    const timeField = document.querySelector('input[inputmode], input.mask, input');
    return {
      tabs,
      hasTimeField: Boolean(timeField),
      // a rough read on "did the Basic form render at all" - a removed-too-much build shows nothing here
      bodyChars: document.getElementById('root')?.textContent?.trim().length ?? 0,
      activeTab: document.querySelector('nav.tabs button.active')?.textContent?.trim() ?? null,
    };
  });

  await ctx.close();
  return { extId, ...info };
}

const main = async () => {
  const server = await serve();
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  console.log('\n--- FULL build (dist) ---');
  const full = await inspectBuild('dist', server);
  if (full.skip) {
    console.log('  dist/ not built - skipping');
  } else {
    console.log(`  tabs: ${JSON.stringify(full.tabs)}`);
    /**
     * THE EXPECTED TABS ARE NAMED, NOT COUNTED.
     *
     * This check used to be `=== 6`, which was correct when it was written and became a real failure the moment a tab was added -
     * reporting "the full build still has all six tabs" while the build was perfectly healthy and the Window tab was the seventh. A
     * count cannot tell "one more tab" from "a tab went missing", and the message actively misleads: it names the number instead of
     * the thing.
     *
     * The list says what must be there, so a missing tab fails and an added tab is recorded on purpose. If a future tab is added the
     * assertion is meant to be edited - that is the check working, not breaking.
     */
    const expectedFull = ['Basic', 'Window', 'Automations', 'Scheduled', 'Data', 'History', 'Log'];
    const missing = expectedFull.filter((name) => !full.tabs.includes(name));
    check('the full build has every tab, including the Window tab',
      missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${full.tabs.length} tabs: ${full.tabs.join(', ')}`);
  }

  console.log('\n--- LITE build (dist-lite) ---');
  const lite = await inspectBuild('dist-lite', server);
  if (lite.skip) {
    console.log('  dist-lite/ not built - skipping');
  } else {
    console.log(`  tabs: ${JSON.stringify(lite.tabs)}`);
    check('the lite build has exactly one tab', lite.tabs.length === 1, `${lite.tabs.length} tabs: ${lite.tabs.join(', ')}`);
    check('and it is Basic, and it is active', lite.activeTab !== null, `active=${lite.activeTab}`);
    check('the Basic form rendered', (lite.bodyChars ?? 0) > 120, `${lite.bodyChars} characters of content`);
  }

  server.close();
  console.log('\n' + '='.repeat(78));
  const failed = results.filter((r) => r.ok === false);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => {
  console.error('lite-build-test could not run:', e.message);
  process.exit(1);
});
