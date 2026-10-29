#!/usr/bin/env node
/**
 * What does a REAL sender object look like for each kind of caller?
 *
 * The sender check passed in unit tests with a hand-built sender and then refused the panel in a real
 * browser, which means the assumption about the real shape is wrong somewhere. This prints the actual
 * object rather than guessing at it.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extPath = path.join(root, 'dist');
const HTML = '<!DOCTYPE html><html><body><button id="b">x</button></body></html>';

async function main() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'autoflow-sender-'));
  const chromePath = process.env.AUTOFLOW_CHROMIUM ||
    '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const launchOptions = {
    headless: true,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`,
      '--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (existsSync(chromePath)) launchOptions.executablePath = chromePath;

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  try {
    let worker = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !worker) {
      worker = context.serviceWorkers()[0] ?? null;
      if (!worker) await new Promise((r) => setTimeout(r, 250));
    }
    if (!worker) throw new Error('no service worker');
    const extensionId = new URL(worker.url()).host;

    // Install a probe in the worker that records the raw sender of each incoming message.
    await worker.evaluate(() => {
      globalThis.__seen = [];
      chrome.runtime.onMessage.addListener((msg, sender) => {
        globalThis.__seen.push({
          type: msg?.type,
          senderId: sender?.id ?? null,
          senderUrl: sender?.url ?? null,
          senderOrigin: sender?.origin ?? null,
          hasTab: Boolean(sender?.tab),
          tabId: sender?.tab?.id ?? null,
          runtimeId: chrome.runtime?.id ?? null,
          idMatches: sender?.id === chrome.runtime?.id,
        });
      });
    });

    // 1. a message from an extension PAGE
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.evaluate(() => new Promise((r) => {
      chrome.runtime.sendMessage({ type: 'probe-from-panel' }, () => r());
    }));

    // 2. a message from a CONTENT SCRIPT
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForTimeout(1500);
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (t.url && t.url.startsWith('http')) {
          await chrome.tabs.sendMessage(t.id, { type: 'run-status', status: 'idle' }).catch(() => {});
        }
      }
    });

    // 3. what does the extension's own worker see for itself?
    const runtimeId = await worker.evaluate(() => chrome.runtime.id);

    await new Promise((r) => setTimeout(r, 600));
    const seen = await worker.evaluate(() => globalThis.__seen);

    console.log('=== extension id ===');
    console.log(`  runtime.id in the worker: ${runtimeId}`);
    console.log(`  id from the worker url   : ${extensionId}`);
    console.log();
    console.log('=== raw sender objects as Chrome provides them ===');
    for (const s of seen) {
      console.log(JSON.stringify(s, null, 2));
      console.log();
    }
  } finally {
    await context.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    server.close();
  }
}

main().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});