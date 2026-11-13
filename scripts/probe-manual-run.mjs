#!/usr/bin/env node
/**
 * WHY DID THE MANUAL RUN NOT CLICK? Ask the worker, rather than guess.
 *
 * The scheduled window fired 360 clicks, so the ENGINE, the page and the content script are all fine. The manual Run path did
 * nothing, so the difference is in that path - and the worker records why a run was refused. This probe reads the run history and
 * the diagnostics and prints them.
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

const PAGE = `<!doctype html><html><body><button id="b1">one</button>
<script>window.__hits=[];document.getElementById('b1').addEventListener('click',()=>window.__hits.push(performance.now()));</script>
</body></html>`;

const main = async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'af-probe-')), {
    executablePath: CHROME, headless: false,
    args: [`--disable-extensions-except=${path.join(ROOT, 'dist')}`, `--load-extension=${path.join(ROOT, 'dist')}`,
      '--no-first-run', '--no-default-browser-check'],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) throw new Error('no service worker appeared');
  const extId = new URL(sw.url()).host;

  const target = await ctx.newPage();
  await target.goto(pageUrl);
  await target.waitForTimeout(1200);

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForFunction(() => document.querySelectorAll('nav.tabs button').length > 0, { timeout: 25000 });
  const send = (m) => panel.evaluate((x) => chrome.runtime.sendMessage(x), m);

  await send({ type: 'remember-pick-page', automationId: 'window', url: pageUrl });

  // a window record whose schedule is in the FUTURE - exactly what saveWindow() produces from the draft
  const futureAt = Date.now() + 120_000;
  await send({
    type: 'save-automation',
    automation: {
      id: 'window', name: 'Window', enabled: true, urls: [pageUrl],
      schedule: { kind: 'once', at: futureAt },
      options: { window: true, untilMs: futureAt + 1800 },
      steps: [{ id: 'w1', kind: 'click', finder: { strategy: 'id', id: 'b1' } }],
    },
  });

  const started = await send({ type: 'start-run', automationId: 'window', trigger: 'manual' });
  console.log('start-run replied:', JSON.stringify(started));
  await panel.waitForTimeout(2500);
  console.log('clicks on the page:', await target.evaluate(() => window.__hits.length));

  const runs = await send({ type: 'list-runs' });
  const last = (runs?.runs ?? []).slice(0, 3).map((r) => ({ id: r.id, name: r.name, reason: r.reason, steps: r.steps, error: r.error?.message ?? null, trigger: r.trigger }));
  console.log('\nrecent runs:');
  for (const r of last) console.log('  ', JSON.stringify(r));

  const sched = await send({ type: 'list-scheduled' });
  console.log('\nlist-scheduled reply keys:', Object.keys(sched ?? {}));
  console.log('  ', JSON.stringify(sched).slice(0, 400));

  await ctx.close();
  server.close();
};
main().catch((e) => { console.error(e); process.exit(1); });
