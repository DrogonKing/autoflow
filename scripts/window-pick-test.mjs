#!/usr/bin/env node
/**
 * A REAL PICK IN THE WINDOW TAB: an actual page, an actual pick mode, an actual click on the page.
 *
 * THE FIRST VERSION OF THIS PROBE MEASURED NOTHING, and the reason is worth recording: it never opened a target page, so the
 * panel answered the Pick press with its own error - `"no page to pick from - open the site you want to pick in"` - and the pick
 * never started. A probe that omits the precondition reports the precondition's absence as a product fault. That painter has been
 * on this project's floor before.
 *
 * So this one does the whole thing: serve a page, open it, press Pick in the Window tab, click the element on the page, and then ask
 * the panel and the worker what they now hold.
 */
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installProfileSweep } from './lib/profile.mjs';

installProfileSweep();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>pick target</title></head>
<body style="font:16px sans-serif">
  <h1>A page to pick from</h1>
  <button id="buy" class="trade-button">Buy 100</button>
  <button id="sell" class="trade-button">Sell 100</button>
</body></html>`;

const main = async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'autoflow-pickwin-')), {
    executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${path.join(ROOT, 'dist')}`, `--load-extension=${path.join(ROOT, 'dist')}`,
      '--no-first-run', '--no-default-browser-check'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 25000 }).catch(() => null);
  if (!sw) throw new Error('no service worker appeared');
  const extId = new URL(sw.url()).host;

  // ---- THE PRECONDITION THE FIRST PROBE OMITTED: a real page, in front, with the content script loaded
  const target = await ctx.newPage();
  await target.goto(pageUrl);
  await target.waitForLoadState('domcontentloaded');
  await target.bringToFront();
  await target.waitForTimeout(1500);

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForFunction(() => document.querySelectorAll('nav.tabs button').length > 0, { timeout: 25000 });
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav.tabs button')].find((x) => /Window|پنجره/.test(x.textContent));
    b?.click();
  });
  await panel.waitForTimeout(1200);

  /**
   * RECORD EVERY MESSAGE THE PANEL RECEIVES, so "the click did nothing" is answered by the messages rather than inferred.
   *
   * A listener added here runs alongside the panel's own, so what it records is exactly what the panel's handler is given.
   */
  await panel.evaluate(() => {
    window.__msgs = [];
    chrome.runtime.onMessage.addListener((m) => {
      /**
       * THE WHOLE FINDER, not one of its keys. Reading `finder.selector` alone reports `null` for a finder built on `text`, `id`
       * or a chain - which is what a real pick produces - so that reading sent the diagnosis in the wrong direction twice. A probe
       * that summarises a structure must summarise all of it.
       */
      window.__msgs.push({
        type: m?.type ?? null,
        keys: Object.keys(m ?? {}),
        finder: m?.finder === undefined ? 'ABSENT' : JSON.stringify(m.finder),
        info: m?.info === undefined ? 'ABSENT' : JSON.stringify(m.info).slice(0, 300),
        url: m?.url ?? null,
      });
      return undefined;
    });
  });

  // put the page back in front: the picker acts on the ACTIVE tab, and the panel has just taken the front
  await target.bringToFront();
  await panel.evaluate(() => {
    const b = document.querySelector('.win-step .pick');
    if (b) b.click();
    else console.warn('no pick button');
  });
  await panel.waitForTimeout(800);

  const waiting = await panel.evaluate(() => ({
    buttonText: document.querySelector('.win-step .pick')?.textContent?.trim() ?? null,
    buttonClass: document.querySelector('.win-step .pick')?.className ?? null,
    banner: document.querySelector('.picking-banner')?.textContent?.trim() ?? null,
    errors: [...document.querySelectorAll('.warn, .win-error, .hint.warn, .notice')].map((n) => n.textContent.trim()),
  }));
  console.log('=== after pressing Pick (page in front) ===');
  console.log(JSON.stringify(waiting, null, 2));

  // ---- the actual pick: click the button on the page, in pick mode
  await target.bringToFront();
  await target.click('#buy', { timeout: 5000 }).catch((e) => console.log('page click threw:', e.message));
  await target.waitForTimeout(1200);

  await panel.bringToFront();
  await panel.waitForTimeout(800);

  const after = await panel.evaluate(() => ({
    selectors: [...document.querySelectorAll('.win-step input.mono')].map((i) => i.value),
    summaries: [...document.querySelectorAll('.win-step .step-summary')].map((s) => s.textContent.trim()),
    pickButtonText: document.querySelector('.win-step .pick')?.textContent?.trim() ?? null,
    banner: Boolean(document.querySelector('.picking-banner')),
    // WHAT ACTUALLY ARRIVED, in order - the evidence, not an inference
    messages: window.__msgs ?? [],
  }));
  console.log('\n=== after clicking #buy on the page ===');
  console.log(JSON.stringify(after, null, 2));

  // ---- and what the worker stored, including the page remembered for the window record
  const rec = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'list-automations' });
    const w = (r?.automations ?? []).find((a) => a.id === 'window');
    if (!w) return 'no window record stored';
    return {
      steps: (w.steps ?? []).map((s) => ({ id: s.id, kind: s.kind, selector: s.finder?.selector ?? null })),
      urls: w.urls,
    };
  });
  console.log('\n=== the stored window record ===');
  console.log(JSON.stringify(rec, null, 2));

  /**
   * THE PANEL'S OWN PICK TRAIL. `recordPickDebug` was built to answer exactly "where did the pick go", so it is read rather than
   * guessed at: it records what the listener received, whether a step claimed it, and which id was waiting.
   */

  /**
   * ASSERTIONS, so this file is a test rather than a probe someone has to read.
   *
   * The fault it locks was measured: a pick in the Window tab found no step waiting for it, because `pickControl` read a mutable
   * global at CLICK time while the tab only set it during the BUILD - so the finder was filed against the Basic list and dropped.
   * Nothing in the unit suite could see it: `pickControl` is not importable, and the handler is a browser listener.
   */
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 240)}` : ''}`);
  };

  console.log('\n=== the assertions ===');
  check('a pick made in the Window tab reaches the point',
    after.selectors.some((v) => String(v).includes('buy')), JSON.stringify(after.selectors));
  check('and the row shows which element it points at',
    after.summaries.some((v) => String(v).includes('buy')), JSON.stringify(after.summaries));
  check('the pick is finished, so the banner is gone', after.banner === false, String(after.banner));
  check('the pick arrived with a finder, so the panel had something to apply',
    (after.messages ?? []).some((m) => m.type === 'element-picked' && m.finder !== 'ABSENT' && m.finder !== null),
    JSON.stringify((after.messages ?? []).map((m) => m.finder).slice(0, 1)));
  /**
   * THE PAGE IS REMEMBERED FOR THE WINDOW RECORD. Without it a scheduled run refuses with "no URL pattern, so a scheduled run has no
   * safe tab" - the same fault Basic had, and the reason the content script sends its location with the pick.
   */
  /**
   * THE PAGE IS KEPT IN THE WORKER'S `lastPickPages`, NOT IN THE RECORD'S `urls`.
   *
   * `remember-pick-page` writes it there, and a run uses it when the record carries no pattern of its own - the documented Basic
   * path. Asserting on `urls` would have failed a correct implementation, which is the mistake this test already made once over a
   * message's field names.
   */
  // it lives in SETTINGS (`saveSettings({ lastPickPages })`), not in the diagnostics payload - read where it is written
  const pages = await panel.evaluate(async () => {
    const d = await chrome.runtime.sendMessage({ type: 'get-settings' }).catch(() => null);
    return d?.settings?.lastPickPages ?? d?.lastPickPages ?? null;
  });
  check('and the page it came from is remembered for the window record',
    Boolean(pages) && Object.keys(pages).some((k) => k === 'window') && String(pages.window ?? '').includes('127.0.0.1'),
    JSON.stringify(pages));

  const failed = results.filter((r) => r.ok === false);
  console.log(`\n${results.length - failed.length} ok · ${failed.length} FAIL`);

  await ctx.close();
  server.close();
  if (failed.length) process.exit(1);
};
main().catch((e) => { console.error(e); process.exit(1); });
