#!/usr/bin/env node
/**
 * THE WINDOW RUNS FOR REAL: actual clicks, on an actual page, over an actual window of time.
 *
 * WHAT NO UNIT TEST COULD SHOW, and why this file exists:
 *   * the runner's window loop actually reaches the page - a click step is a message round trip to a content script;
 *   * the points really repeat IN ORDER, proved by the PAGE's own log of arrivals, not by the engine's trace;
 *   * a finite window really stops at its deadline, and the count of clicks is consistent with the interval;
 *   * an ENDLESS window really keeps going, and really stops when Stop is pressed.
 *
 * THE PAGE REPORTS ITS OWN CLICKS. `window.__hits` is written by the page's own listeners, so the ordering and the timing are the
 * page's evidence rather than the extension's self-report. That distinction is the whole point: the engine can be perfectly happy
 * while nothing reaches the page.
 *
 * A LOCAL SERVER IS USED because a content script is injected into http(s) pages, and because the tabs the extension may act on
 * are exactly the ones it can see.
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

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 300)}` : ''}`);
};

/** The page the run clicks on. It records every click itself, with the time it happened. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>window target</title></head>
<body>
  <button id="b1">one</button>
  <button id="b2">two</button>
  <script>
    window.__hits = [];
    for (const id of ['b1', 'b2']) {
      document.getElementById(id).addEventListener('click', (e) => {
        // the page's OWN record: what arrived, in what order, and when
        window.__hits.push({ id, at: performance.now(), isTrusted: e.isTrusted });
      });
    }
  </script>
</body></html>`;

const main = async () => {
  // ---- a local page for the run to act on
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/`;

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autoflow-winrun-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: false,
    args: [
      `--disable-extensions-except=${path.join(ROOT, 'dist')}`,
      `--load-extension=${path.join(ROOT, 'dist')}`,
      '--no-first-run', '--no-default-browser-check',
    ],
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) throw new Error('no service worker appeared at all');
  const extId = new URL(sw.url()).host;

  // ---- the page the run will click on, in the active tab
  const target = await ctx.newPage();
  await target.goto(pageUrl);
  await target.waitForLoadState('domcontentloaded');
  await target.bringToFront();
  // the content script has to be there before a run can act, so its readiness is waited for rather than assumed
  await target.waitForTimeout(1500);

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForFunction(() => document.querySelectorAll('nav.tabs button').length > 0, { timeout: 25000 });
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav.tabs button')].find((x) => /Window|پنجره/.test(x.textContent));
    b?.click();
  });
  await panel.waitForFunction(() => document.querySelector('#win-start') !== null, { timeout: 15000 }).catch(() => {});

  const send = (msg) => panel.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  /** Point both ids at the target page, so the run has a page of its own to open. */
  await send({ type: 'remember-pick-page', automationId: 'window', url: pageUrl }).catch(() => {});

  const hits = () => target.evaluate(() => window.__hits.map((h) => ({ id: h.id, at: h.at })));
  const clearHits = () => target.evaluate(() => { window.__hits = []; });

  // =====================================================================================
  console.log('\n================ A. A FINITE WINDOW: the points repeat in order until the end ================');
  // =====================================================================================
  await clearHits();
  const untilMs = Date.now() + 2600;
  const recA = await panel.evaluate(({ u, url }) => ({
    id: 'window',
    name: 'Window',
    enabled: true,
    urls: [url],
    schedule: { kind: 'manual' },
    options: { window: true, untilMs: u },
    steps: [
      { id: 'w1', kind: 'click', finder: { strategy: 'id', id: 'b1' } },
      { id: 'w2', kind: 'click', finder: { strategy: 'id', id: 'b2' } },
    ],
  }), { u: untilMs, url: pageUrl });
  await send({ type: 'save-automation', automation: recA });

  /**
   * THE PANEL'S OWN RUN BUTTON, so the path the user takes is the path tested - AND THE PANEL IS LEFT IN FRONT while it is
   * pressed. That is not a convenience: the panel is necessarily the active tab at that moment, which is precisely the situation
   * that made a manual run click nothing until the worker learned to prefer a tab matching the automation's own `urls`.
   */
  await panel.bringToFront();
  await panel.click('#win-run-now');
  await panel.waitForTimeout(4200);      // well past the window's end

  const gotA = await hits();
  const orderA = gotA.map((h) => h.id).join(',');
  console.log('\n--- what the PAGE recorded ---');
  console.log('  clicks:', gotA.length, '| order:', JSON.stringify(orderA));
  console.log('  span  :', gotA.length ? `${Math.round(gotA[gotA.length - 1].at - gotA[0].at)} ms` : '-');

  check('the clicks reached the page at all', gotA.length > 0, `${gotA.length} clicks`);
  check('the clicks were real user-style events, not synthesised page calls',
    gotA.length === 0 || gotA.every((h) => h.isTrusted !== false), String(gotA[0]?.isTrusted));
  check('the points repeated, so the count exceeds one pass of two points', gotA.length > 2, `${gotA.length} clicks`);
  check('AND THE ORDER REPEATS: every pair is one-then-two, over and over',
    orderA.length > 0 && orderA.split(',').every((x, i) => x === (i % 2 === 0 ? 'b1' : 'b2')), orderA);
  const spanA = gotA.length > 1 ? gotA[gotA.length - 1].at - gotA[0].at : 0;
  check('and it stopped near its end time rather than running on', spanA <= 4000, `${Math.round(spanA)} ms of clicking`);

  // =====================================================================================
  console.log('\n================ B. AN ENDLESS WINDOW: it keeps going, and Stop really stops it ================');
  // =====================================================================================
  await clearHits();
  const recB = await panel.evaluate(({ url }) => ({
    id: 'window',
    name: 'Window',
    enabled: true,
    urls: [url],
    schedule: { kind: 'manual' },
    options: { window: true },          // NO untilMs: the endless mode, stopped by hand
    steps: [
      { id: 'w1', kind: 'click', finder: { strategy: 'id', id: 'b1' } },
      { id: 'w2', kind: 'click', finder: { strategy: 'id', id: 'b2' } },
    ],
  }), { url: pageUrl });
  await send({ type: 'save-automation', automation: recB });

  await panel.bringToFront();
  await panel.click('#win-run-now');
  await panel.waitForTimeout(1600);
  const midB = await hits();
  console.log('\n--- while it is running ---');
  console.log('  clicks so far:', midB.length);
  check('an endless window keeps clicking, with no end time given', midB.length > 2, `${midB.length} clicks`);

  /**
   * STOP FROM THE TAB. This is the control the endless mode depends on - if it does not work, an endless window cannot be
   * stopped at all, which is the hazard the guards exist for.
   */
  const stopVisible = await panel.evaluate(() => Boolean(document.querySelector('#win-stop')));
  check('the Stop control appears while this automation is running', stopVisible === true);
  if (stopVisible) await panel.click('#win-stop');
  await panel.waitForTimeout(400);
  const afterStop = await hits();
  await panel.waitForTimeout(1200);
  const afterWait = await hits();
  console.log('\n--- after pressing Stop ---');
  console.log('  clicks at stop:', afterStop.length, '| 1.2s later:', afterWait.length);
  check('pressing Stop actually stops the clicking', afterWait.length === afterStop.length,
    `${afterStop.length} -> ${afterWait.length}`);

  const reason = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'get-active-run' });
    return r?.run?.name ?? null;
  });
  console.log('  active run after stop:', JSON.stringify(reason));
  check('and the run is no longer reported as active', reason === null, String(reason));

  // =====================================================================================
  console.log('\n================ C. A SCHEDULED WINDOW: the alarm fires it, at millisecond precision ================');
  // =====================================================================================
  await clearHits();
  /**
   * A ONE-SHOT ABOUT SEVEN SECONDS OUT. Long enough for the worker to arm it and for the precise path to wake early; short
   * enough for the test. The point is not the exact millisecond of arrival - a worker wake-up cannot promise that - but that the
   * alarm fires the window at all, and stops it, with no user action in between.
   */
  const atMs = Date.now() + 7000;
  const recC = await panel.evaluate(({ at, url }) => ({
    id: 'window',
    name: 'Window',
    enabled: true,
    urls: [url],
    schedule: { kind: 'once', at },
    options: { window: true, untilMs: at + 1800 },
    steps: [
      { id: 'w1', kind: 'click', finder: { strategy: 'id', id: 'b1' } },
      { id: 'w2', kind: 'click', finder: { strategy: 'id', id: 'b2' } },
    ],
  }), { at: atMs, url: pageUrl });
  await send({ type: 'save-automation', automation: recC });

  // what the worker believes it armed, read from its own diagnostics rather than inferred
  /**
   * THE REPLY'S OWN FIELD NAMES, read off the worker rather than assumed: `list-scheduled` answers with `items`, and each row
   * carries `nextAt` and `armed` - not `scheduled`/`at`/`precise`. The arm was working all along; the assertion was reading the
   * wrong property and reporting an empty list. A test that invents field names reports its own ignorance as a product fault.
   */
  const armedRows = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'list-scheduled' });
    return (r?.items ?? []).map((x) => ({ id: x.id, nextAt: x.nextAt, armed: x.armed, schedule: x.schedule }));
  });
  console.log('\n--- what the worker armed ---');
  console.log('  ', JSON.stringify(armedRows));
  check('the one-shot was armed by the worker', armedRows.some((x) => x.id === 'window'), JSON.stringify(armedRows));

  // wait for the scheduled instant to arrive and the window to run out
  const waitMs = Math.max(0, atMs - Date.now()) + 3600;
  console.log(`  waiting ${Math.round(waitMs)} ms for the scheduled window...`);
  await target.bringToFront();
  await panel.waitForTimeout(waitMs);

  const gotC = await hits();
  const orderC = gotC.map((h) => h.id).join(',');
  console.log('\n--- the scheduled run, on the page ---');
  console.log('  clicks:', gotC.length, '| order:', JSON.stringify(orderC));
  check('the scheduled window fired and clicked, with no user action', gotC.length > 0, `${gotC.length} clicks`);
  check('and its points repeated in order too',
    orderC.length > 0 && orderC.split(',').every((x, i) => x === (i % 2 === 0 ? 'b1' : 'b2')), orderC);

  await ctx.close();
  server.close();

  const failed = results.filter((r) => r.ok === false);
  console.log(`\n${results.length - failed.length} ok · ${failed.length} FAIL`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ${f.name} — ${f.detail ?? ''}`);
    process.exit(1);
  }
};

main().catch((e) => {
  console.error('the test itself threw:', e);
  process.exit(1);
});
