#!/usr/bin/env node
/**
 * Measure click throughput through the real extension, and the real key-chord behaviour.
 *
 * Why this is measured in a browser rather than computed: every step is a message round-trip
 * (service worker -> content script -> DOM -> back). A number derived from the runner alone would ignore
 * that, and the round-trip is what actually sets the floor in practice.
 *
 * It also answers the second question by observation: dispatch ctrl+shift+T and record when each event
 * arrives, so "are several keys held at once" is answered from the event order rather than from reading
 * the code.
 *
 * Usage: node scripts/measure-browser.mjs
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

/** The page records every event with a timestamp, so ordering and simultaneity are observable. */
const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>timing</title></head>
<body>
  <button id="btn" style="width:200px;height:60px">Target</button>
  <input id="field" style="width:300px">
  <div id="log"></div>
  <script>
    window.__clicks = 0;
    window.__events = [];
    const btn = document.getElementById('btn');
    btn.addEventListener('click', () => { window.__clicks++; });
    const field = document.getElementById('field');
    field.focus();
    for (const type of ['keydown','keypress','keyup']) {
      field.addEventListener(type, (e) => {
        window.__events.push({ type, key: e.key, code: e.code, t: performance.now(),
          ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
      });
    }
  </script>
</body></html>`;

async function main() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'autoflow-timing-'));
  const explicitChromium = process.env.AUTOFLOW_CHROMIUM ||
    '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const launchOptions = {
    headless: true,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`,
      '--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (existsSync(explicitChromium)) launchOptions.executablePath = explicitChromium;

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  try {
    let worker = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !worker) {
      worker = context.serviceWorkers()[0] ?? null;
      if (!worker) await new Promise((r) => setTimeout(r, 250));
    }
    if (!worker) throw new Error('the service worker did not start');
    const extensionId = new URL(worker.url()).host;

    const bridge = await context.newPage();
    await bridge.goto(`chrome-extension://${extensionId}/panel.html`);
    const ask = (msg) => bridge.evaluate((m) => new Promise((resolve) => {
      chrome.runtime.sendMessage(m, (r) => resolve(r ?? null));
    }), msg);

    const page = await context.newPage();
    await page.goto(url);
    await page.waitForTimeout(1200);

    async function runClicks(count, stepDelayMs) {
      const automation = {
        id: `bench-${count}-${stepDelayMs}`,
        name: `bench ${count}`,
        steps: Array.from({ length: count }, (_, i) => ({
          id: `c${i}`, kind: 'click', finder: { strategy: 'css', selector: '#btn' },
        })),
        schedule: { kind: 'manual' },
        options: { stepDelayMs, stepRetries: 0, maxRunMs: 120_000 },
        enabled: true,
      };
      await ask({ type: 'save-automation', automation });
      await page.evaluate(() => { window.__clicks = 0; });
      const t0 = Date.now();
      const res = await bridge.evaluate(async (id) => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'start-run', automationId: id }, (r) => resolve(r ?? null));
      }), automation.id);
      const wall = Date.now() - t0;
      const clicks = await page.evaluate(() => window.__clicks);
      return { count, stepDelayMs, wallMs: wall, clicks, elapsed: res?.run?.elapsedMs ?? null, reason: res?.run?.reason };
    }

    console.log('=== real click throughput through the extension ===');
    console.log('  clicks  stepDelay   wall time   per click   page counted');
    for (const [count, delay] of [[20, 0], [50, 0], [50, 1], [50, 5], [100, 0]]) {
      const r = await runClicks(count, delay);
      console.log(
        `  ${String(r.count).padStart(6)}  ${String(r.stepDelayMs).padStart(8)}ms  ` +
        `${String(r.wallMs).padStart(8)}ms  ${(r.wallMs / r.count).toFixed(2).padStart(8)}ms  ` +
        `${String(r.clicks).padStart(6)}${r.reason !== 'finished' ? `  (${r.reason})` : ''}`,
      );
    }

    console.log('\n=== what a key step actually dispatches ===');
    for (const keys of ['a', 'ctrl+shift+t', 'ctrl+a', 'a+b']) {
      await page.evaluate(() => { window.__events = []; document.getElementById('field').focus(); });
      const automation = {
        id: `keys-${keys.replace(/\+/g, '_')}`,
        name: `keys ${keys}`,
        steps: [{ id: 'k', kind: 'key', finder: { strategy: 'css', selector: '#field' }, keys, gapMs: 0 }],
        schedule: { kind: 'manual' },
        options: { stepDelayMs: 0, stepRetries: 0, maxRunMs: 20_000 },
        enabled: true,
      };
      await ask({ type: 'save-automation', automation });
      await bridge.evaluate(async (id) => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'start-run', automationId: id }, (r) => resolve(r ?? null));
      }), automation.id);
      const events = await page.evaluate(() => window.__events);
      const seq = events.map((e) => `${e.type === 'keydown' ? '↓' : e.type === 'keyup' ? '↑' : '·'}${e.key}`).join(' ');
      const span = events.length ? (events[events.length - 1].t - events[0].t).toFixed(2) : '0';
      console.log(`  keys="${keys}"`.padEnd(26) + `  ${seq || '(no events)'}   span ${span}ms`);
    }

    // simultaneous, or sequential? check whether any two keydowns happen before a keyup
    console.log('\n=== are two non-modifier keys ever held at the same time? ===');
    await page.evaluate(() => { window.__events = []; document.getElementById('field').focus(); });
    const chord = {
      id: 'chord-test',
      name: 'chord',
      steps: [{ id: 'k', kind: 'key', finder: { strategy: 'css', selector: '#field' }, keys: 'a+b' }],
      schedule: { kind: 'manual' },
      options: { stepDelayMs: 0, stepRetries: 0, maxRunMs: 20_000 },
      enabled: true,
    };
    await ask({ type: 'save-automation', automation: chord });
    await bridge.evaluate(async (id) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'start-run', automationId: id }, (r) => resolve(r ?? null));
    }), chord.id);
    const ev = await page.evaluate(() => window.__events);
    const order = ev.map((e) => `${e.type}:${e.key}`);
    console.log(`  event order: ${order.join(' -> ')}`);
    const firstUp = order.findIndex((o) => o.startsWith('keyup'));
    const downsBeforeUp = order.slice(0, firstUp < 0 ? order.length : firstUp).filter((o) => o.startsWith('keydown'));
    console.log(`  keydowns before the first keyup: ${downsBeforeUp.length} (${downsBeforeUp.join(', ') || 'none'})`);
    console.log(`  => ${downsBeforeUp.length > 1
      ? 'TWO KEYS HELD AT ONCE (a real chord)'
      : 'sequential — each key is released before the next goes down'}`);
  } finally {
    await context.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    server.close();
  }
}

main().catch((e) => {
  console.error('measurement failed:', e.message);
  process.exit(1);
});
