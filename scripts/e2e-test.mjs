#!/usr/bin/env node
/**
 * End-to-end: does an automation actually DO something to a real page?
 *
 * The other browser test proves the extension loads and the UI works. This one proves the thing the whole
 * extension exists for: a saved automation, run through the service worker's runner, driving a content
 * script in a real page, producing real observable effects — clicks, filled fields, an extracted value,
 * a loop that ran N times, and a scheduled run that fires.
 *
 * A local HTTP server is used rather than a file:// page, because <all_urls> does not match file URLs and
 * the content script therefore would not inject — which is correct behaviour, and the reason a file page
 * is the wrong test.
 *
 * Usage: node scripts/e2e-test.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extPath = path.join(root, 'dist');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -> ${detail}` : ''}`);
}

/** A page with everything a step can act on, and a script that records what happened to it. */
const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AutoFlow E2E</title></head>
<body>
  <h1 id="status">idle</h1>
  <button id="go" onclick="window.__clicks = (window.__clicks||0)+1; document.getElementById('clicks').textContent = String(window.__clicks); document.getElementById('status').textContent = 'clicked';">Go</button>
  <span id="clicks">0</span>
  <input id="email" placeholder="Email">
  <input type="checkbox" id="terms"><label for="terms">Accept terms</label>
  <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
  <div id="items"><span class="item">alpha</span><span class="item">beta</span><span class="item">gamma</span></div>
  <div id="hidden-target" style="display:none">hidden text</div>
  <script>
    window.__events = [];
    for (const id of ['email','terms','plan']) {
      const el = document.getElementById(id);
      el.addEventListener('input', () => window.__events.push('input:'+id));
      el.addEventListener('change', () => window.__events.push('change:'+id));
    }
    document.getElementById('go').addEventListener('click', () => window.__events.push('click:go'));
  </script>
</body></html>`;

async function main() {
  if (!existsSync(path.join(extPath, 'manifest.json'))) throw new Error('run npm run build first');

  // ---- a real HTTP server, so <all_urls> matches and the content script injects
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  console.log(`test page served at ${url}\n`);

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'autoflow-e2e-'));
  const explicitChromium = process.env.AUTOFLOW_CHROMIUM ||
    '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

  const launchOptions = {
    headless: true,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
  if (existsSync(explicitChromium)) launchOptions.executablePath = explicitChromium;

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);

  try {
    /**
     * Wait for the service worker, and WAKE it rather than waiting passively.
     *
     * An MV3 worker is killed when idle and starts on an event. Polling `context.serviceWorkers()` alone waits
     * for the browser to decide to wake it, which is intermittent - it failed roughly one run in three. Opening
     * an extension page and messaging from it is the event that starts the worker, so the loop nudges it.
     */
    const extensionIdFromAnyWorker = () => {
      const w = context.serviceWorkers()[0];
      return w ? new URL(w.url()).host : null;
    };
    let worker = null;
    let extensionId = extensionIdFromAnyWorker();
    const deadline = Date.now() + 25_000;
    let nudges = 0;
    while (Date.now() < deadline && !worker) {
      worker = context.serviceWorkers()[0] ?? null;
      if (worker) {
        extensionId = new URL(worker.url()).host;
        break;
      }
      if (nudges++ % 8 === 0) {
        // opening an extension page is enough to wake the worker; close it again so the tab count stays clean
        const nudge = await context.newPage().catch(() => null);
        if (nudge) {
          await nudge.goto(`chrome-extension://${process.env.AUTOFLOW_EXT_ID ?? 'x'}/panel.html`).catch(() => {});
          await nudge.close().catch(() => {});
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!worker) {
      // last resort: ask the browser for the extension's id from the targets it knows about
      const targets = context.pages().map((p) => p.url()).filter((u) => u.startsWith('chrome-extension://'));
      throw new Error(`the service worker did not start after 25s (extension pages seen: ${JSON.stringify(targets)})`);
    }
    extensionId = new URL(worker.url()).host;

    // a page to send messages from (the worker cannot message itself)
    const bridge = await context.newPage();
    await bridge.goto(`chrome-extension://${extensionId}/panel.html`);
    const ask = (msg) => bridge.evaluate((m) => new Promise((resolve) => {
      chrome.runtime.sendMessage(m, (r) => resolve(r ?? null));
    }), msg);

    // ---- the target page
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForLoadState('load');
    // give the content script a moment to register its listener
    await page.waitForTimeout(1200);

    /**
     * Is the content script present?
     *
     * NOT via `typeof chrome.runtime` in page.evaluate: a content script runs in an isolated world, so the
     * page's main world has no access to its `chrome` object and that check is always false. The script
     * publishes a DOM marker instead, which the page CAN see, and that is what is asserted here.
     */
    const marker = await page.evaluate(() => document.documentElement.getAttribute('data-autoflow-content'));
    check('the content script injected into the http page (via its DOM marker)', Boolean(marker),
      `data-autoflow-content=${marker}`);
    const topMarker = await page.evaluate(() => document.documentElement.getAttribute('data-autoflow-top'));
    check('the top frame is marked as such', topMarker === '1', String(topMarker));

    // the ping round-trip is checked further down, once the tab id is known: `ping-tab` needs an explicit id
    // because "the active tab" can be an extension page here

    // ---- an automation that exercises the whole step vocabulary against the real page
    const automation = {
      id: 'e2e',
      name: 'end to end',
      steps: [
        { id: 'a', kind: 'click', finder: { strategy: 'css', selector: '#go' } },
        { id: 'b', kind: 'click', finder: { strategy: 'text', text: 'Go' } },
        { id: 'c', kind: 'fill', finder: { strategy: 'placeholder', placeholder: 'Email' }, value: 'user${random.int(10,99)}@example.com' },
        { id: 'd', kind: 'check', finder: { strategy: 'label', label: 'Accept terms' }, checked: true },
        { id: 'e', kind: 'select', finder: { strategy: 'css', selector: '#plan' }, value: 'pro' },
        { id: 'f', kind: 'extract', finder: { strategy: 'css', selector: '#clicks' }, source: 'text', name: 'clicksBefore' },
        {
          id: 'g',
          kind: 'loop',
          loopType: 'count',
          count: 4,
          steps: [{ id: 'h', kind: 'click', finder: { strategy: 'css', selector: '#go' } }],
        },
        { id: 'i', kind: 'extract', finder: { strategy: 'css', selector: '#clicks' }, source: 'text', name: 'clicksAfter' },
        { id: 'j', kind: 'extract', finder: { strategy: 'css', selector: '.item' }, source: 'count', name: 'itemCount' },
        { id: 'k', kind: 'wait', ms: 120 },
        { id: 'l', kind: 'setVariable', name: 'summary', value: 'clicks ${clicksBefore}->${clicksAfter}, items ${itemCount}' },
      ],
      schedule: { kind: 'manual' },
      options: { stepDelayMs: 40, stepRetries: 2, maxRunMs: 60_000 },
      enabled: true,
      urls: [],
    };

    const saved = await ask({ type: 'save-automation', automation });
    check('the automation is saved', Boolean(saved?.ok), saved?.error ?? '');

    /**
     * Resolve the tab id of the test page and target runs at it explicitly.
     *
     * Without this the run targets "the active tab", and in this harness that can be the extension's own
     * options.html - which an automation cannot drive ("Extension manifest must request permission to access
     * this host"). That produced an intermittent failure that looked like a regression. Naming the tab makes
     * the test hermetic about what it is testing.
     */
    const testTabId = await bridge.evaluate(async (origin) => {
      const tabs = await new Promise((r) => chrome.tabs.query({}, (t) => r(t ?? [])));
      const match = tabs.find((t) => (t.url ?? '').startsWith(origin));
      return match ? match.id : null;
    }, `http://127.0.0.1:${port}`);
    check('the test page tab is identified', typeof testTabId === 'number', `tabId=${testTabId}`);
    // the evaluate callbacks are serialised into the page, so the id has to live there
    await bridge.evaluate((id) => { globalThis.TEST_TAB = id; }, testTabId);

    // and the worker can reach it: a ping round-trip proves the message channel works. Sent from the BRIDGE
    // page, which is where TEST_TAB is set, and with the id named explicitly - "the active tab" can be an
    // extension page in this harness, and the resulting error reads as a broken message channel rather than
    // as a wrongly-chosen tab.
    const pinged = await bridge.evaluate(async (id) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'ping-tab', tabId: id }, (r) => resolve(r ?? null));
    }), testTabId).catch(() => null);
    check('the worker can reach the content script', pinged?.ok === true, JSON.stringify(pinged));
    check('the ping names the tab it used, so a wrong tab is visible rather than inferred',
      pinged?.tabId === testTabId, `pinged tabId=${pinged?.tabId} expected ${testTabId}`);

    // ---- RUN IT. This is the whole point.
    const runResult = await bridge.evaluate(async (id) => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'start-run', automationId: id, tabId: TEST_TAB }, (r) => resolve(r ?? null));
      });
    }, 'e2e');
    check('the run reports success', runResult?.ok === true, runResult?.error ?? '');
    const run = runResult?.run;
    check('the run finished rather than failing', run?.reason === 'finished', `reason=${run?.reason} error=${run?.error?.message ?? 'none'}`);

    // ---- did it actually DO anything to the page?
    const observed = await page.evaluate(() => ({
      clicks: document.getElementById('clicks').textContent,
      status: document.getElementById('status').textContent,
      email: document.getElementById('email').value,
      terms: document.getElementById('terms').checked,
      plan: document.getElementById('plan').value,
      events: window.__events ?? [],
    }));

    console.log(`\n  page state: clicks=${observed.clicks} status=${observed.status} email=${observed.email}`);
    console.log(`              terms=${observed.terms} plan=${observed.plan}`);
    console.log(`  events seen by the page: ${observed.events.join(', ') || '(none)'}\n`);

    check('the click step ran (page counter moved)', Number(observed.clicks) >= 6,
      `clicks=${observed.clicks} (expected 1 + 1 by text + 4 in the loop = 6)`);
    check('the page script observed the click', observed.events.includes('click:go'),
      observed.events.join(','));
    check('the fill step set a value with a random template', /^user\d+@example\.com$/.test(observed.email),
      observed.email);
    check('the page saw the input event (React-style compatibility)', observed.events.includes('input:email'),
      observed.events.join(','));
    check('the check step checked the box', observed.terms === true, String(observed.terms));
    check('the page saw the change event for the checkbox', observed.events.includes('change:terms'),
      observed.events.join(','));
    check('the select step chose the option', observed.plan === 'pro', observed.plan);
    check('the loop ran exactly its count', Number(observed.clicks) === 6, `clicks=${observed.clicks}`);

    // ---- extracted values reached the variables
    const vars = run?.trace?.filter((t) => t.type === 'variable') ?? [];
    const summary = vars.find((v) => v.name === 'summary');
    check('an extract read the page into a variable', vars.some((v) => v.name === 'clicksBefore'),
      JSON.stringify(vars.map((v) => `${v.name}=${v.value}`).slice(0, 5)));
    check('a count extract counted the matches', vars.some((v) => v.name === 'itemCount' && v.value === '3'),
      JSON.stringify(vars.find((v) => v.name === 'itemCount') ?? null));
    check('the summary template interpolated the extracted values',
      Boolean(summary && /clicks \d+->\d+, items 3/.test(summary.value)), summary?.value ?? 'none');

    // ---- the trace explains what happened
    const stepOk = run?.trace?.filter((t) => t.type === 'step-ok') ?? [];
    check('every step is in the trace as ok', stepOk.length >= 12, `${stepOk.length} step-ok entries`);

    // ---- a waitFor that should succeed, and one that should time out
    const waitAutomation = {
      id: 'e2e-wait',
      name: 'wait behaviour',
      steps: [
        {
          id: 'w1',
          kind: 'waitFor',
          finder: { strategy: 'css', selector: '#status' },
          condition: { source: 'text', comparator: 'eq', value: 'clicked' },
          timeoutMs: 3000,
          pollMs: 100,
        },
      ],
      schedule: { kind: 'manual' },
      options: { stepDelayMs: 0, stepRetries: 0, maxRunMs: 10_000 },
      enabled: true,
    };
    await ask({ type: 'save-automation', automation: waitAutomation });
    const waitRun = await bridge.evaluate(async (id) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'start-run', automationId: id, tabId: TEST_TAB }, (r) => resolve(r ?? null));
    }), 'e2e-wait');
    check('waitFor succeeds on a condition that already holds', waitRun?.run?.reason === 'finished',
      `reason=${waitRun?.run?.reason}`);

    const failAutomation = {
      id: 'e2e-waitfail',
      name: 'wait failure',
      steps: [
        {
          id: 'wf1',
          kind: 'waitFor',
          finder: { strategy: 'css', selector: '#status' },
          condition: { source: 'text', comparator: 'eq', value: 'never-this-value' },
          timeoutMs: 1500,
          pollMs: 150,
        },
      ],
      schedule: { kind: 'manual' },
      options: { stepDelayMs: 0, stepRetries: 0, maxRunMs: 20_000 },
      enabled: true,
    };
    await ask({ type: 'save-automation', automation: failAutomation });
    const failRun = await bridge.evaluate(async (id) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'start-run', automationId: id, tabId: TEST_TAB }, (r) => resolve(r ?? null));
    }), 'e2e-waitfail');
    check('waitFor reports a clear failure on timeout', failRun?.run?.reason === 'step-error' &&
      /waited 1500 ms/.test(failRun?.run?.error?.message ?? ''), failRun?.run?.error?.message ?? 'no error');

    // ---- a missing element fails with the finder detail, not a generic error
    const missingAutomation = {
      id: 'e2e-missing',
      name: 'missing element',
      steps: [{ id: 'm1', kind: 'click', finder: { strategy: 'css', selector: '#does-not-exist' } }],
      schedule: { kind: 'manual' },
      options: { stepDelayMs: 0, stepRetries: 0, maxRunMs: 10_000 },
      enabled: true,
    };
    await ask({ type: 'save-automation', automation: missingAutomation });
    const missRun = await bridge.evaluate(async (id) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'start-run', automationId: id, tabId: TEST_TAB }, (r) => resolve(r ?? null));
    }), 'e2e-missing');
    check('a missing element explains itself', /could not find/.test(missRun?.run?.error?.message ?? ''),
      missRun?.run?.error?.message ?? 'no error');

    // ---- the run is recorded in history
    const runs = await ask({ type: 'list-runs' });
    check('the runs are recorded in history', (runs?.runs?.length ?? 0) >= 4, `${runs?.runs?.length} runs`);

    // ---- SCHEDULING: arm an alarm and confirm it fires and runs
    const scheduledAutomation = {
      id: 'e2e-scheduled',
      name: 'scheduled run',
      steps: [{ id: 'sc1', kind: 'setVariable', name: 'firedAt', value: '${now.iso}' }],
      schedule: { kind: 'interval', everyMs: 2000 },
      options: { stepDelayMs: 0, stepRetries: 0, maxRunMs: 10_000 },
      enabled: true,
    };
    await ask({ type: 'save-automation', automation: scheduledAutomation });
    const sched = await ask({ type: 'schedule-one', automationId: 'e2e-scheduled' });
    check('a schedule is armed as an alarm', sched?.scheduled === true, JSON.stringify(sched));

    const armed = await ask({ type: 'list-scheduled' });
    const armedOne = armed?.items?.find((i) => i.id === 'e2e-scheduled');
    check('the armed schedule reports a next time', Boolean(armedOne?.nextAt), String(armedOne?.nextAt));
    check('the armed schedule is described in words', /Every 2 seconds/.test(armedOne?.schedule ?? ''),
      armedOne?.schedule ?? '');

    // wait for the alarm to fire and prove a run happened without anyone pressing anything
    console.log('\n  waiting up to 12s for the scheduled run to fire by itself...');
    let autoRan = false;
    const schedDeadline = Date.now() + 12_000;
    while (Date.now() < schedDeadline && !autoRan) {
      const r = await ask({ type: 'list-runs' });
      autoRan = (r?.runs ?? []).some((x) => x.automationId === 'e2e-scheduled' && x.trigger === 'schedule');
      if (!autoRan) await new Promise((r2) => setTimeout(r2, 500));
    }
    check('the scheduled run fired on its own', autoRan,
      autoRan ? 'a run with trigger=schedule appeared in history' : 'no scheduled run within 12s');
  } finally {
    await context.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\ne2e test could not run:', e.message);
  process.exit(1);
});