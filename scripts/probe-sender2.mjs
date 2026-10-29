#!/usr/bin/env node
/**
 * What `sender` does a CONTENT SCRIPT see when the service worker messages it?
 *
 * The guard on the content-script side rejects a sender whose url starts with chrome-extension://, on the
 * assumption that only an extension page carries such a url. If the worker's own messages carry one too,
 * the guard rejects the worker and every page action fails — which is exactly what the end-to-end test
 * reported. Measure rather than assume again.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extPath = path.join(root, 'dist');

const HTML = `<!DOCTYPE html><html><body>
<button id="b">x</button>
<script>
  // The content script runs in an isolated world, so it cannot write a page-visible variable directly.
  // Instead it publishes what it saw as a DOM attribute, which the page CAN read.
  document.documentElement.setAttribute('data-probe-ready', '1');
</script>
</body></html>`;

async function main() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'autoflow-sender2-'));
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

    const page = await context.newPage();
    await page.goto(url);
    await page.waitForTimeout(1500);

    // Patch the content script's listener from inside the worker is not possible; instead send a message
    // whose handler records what it saw. The content script's ping handler replies with url/readyState;
    // use a special type that makes it echo the sender.
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-autoflow-content'));
    console.log(`content marker present: ${before}`);

    // Ask the worker to send a message to the tab, then read what the content script recorded.
    const echo = await worker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith('http'));
      if (!tab) return { error: 'no http tab found' };
      const inside = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => new Promise((resolve) => {
          // this runs in the ISOLATED world, so chrome.runtime is available
          const listener = (msg, sender, respond) => {
            if (msg?.type === '__sender-probe__') {
              resolve({
                senderId: sender?.id ?? null,
                senderUrl: sender?.url ?? null,
                senderOrigin: sender?.origin ?? null,
                hasTab: Boolean(sender?.tab),
                tabUrl: sender?.tab?.url ?? null,
                runtimeId: chrome.runtime?.id ?? null,
              });
              respond({ ok: true });
            }
            return undefined;
          };
          chrome.runtime.onMessage.addListener(listener);
          // ask the worker to message us back
          chrome.runtime.sendMessage({ type: '__arm-sender-probe__' });
        }),
      });
      // separate call to send
      return inside?.[0]?.result ?? null;
    }, url).catch((e) => ({ error: e.message }));

    console.log('\n=== sender as seen INSIDE a content-script world ===');
    if (echo?.error) {
      console.log(`  probe could not complete: ${echo.error}`);
    } else {
      console.log(JSON.stringify(echo, null, 2));
    }

    // The simpler measurement: have the worker send a real message and have the injected probe answer.
    const result = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith('http'));
      if (!tab) return { error: 'no tab' };
      return await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // install a recording listener and then trigger the worker to send
          globalThis.__seenSender = null;
          chrome.runtime.onMessage.addListener((msg, sender) => {
            if (globalThis.__seenSender === null) {
              globalThis.__seenSender = {
                type: msg?.type,
                id: sender?.id ?? null,
                url: sender?.url ?? null,
                origin: sender?.origin ?? null,
                tab: Boolean(sender?.tab),
                tabUrl: sender?.tab?.url ?? null,
              };
            }
            return undefined;
          });
          chrome.runtime.sendMessage({ type: '__trigger__' });
          return 'armed';
        },
      });
    });
    console.log(`\nprobe arm: ${JSON.stringify(result?.[0]?.result ?? result)}`);

    await new Promise((r) => setTimeout(r, 500));

    // read it back
    const seen = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith('http'));
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => globalThis.__seenSender,
      });
      return out?.[0]?.result ?? null;
    });
    console.log('\n=== recorded sender (from a guarded send) ===');
    console.log(JSON.stringify(seen, null, 2));

    // Finally: what the ACTUAL content script sees. Send a ping and see whether it answers at all.
    const ping = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith('http'));
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
        return { answered: true, res };
      } catch (e) {
        return { answered: false, error: String(e.message) };
      }
    });
    console.log('\n=== does the shipped content script answer a ping? ===');
    console.log(JSON.stringify(ping, null, 2));
    console.log('\n(content-script bundle guard:');
    const bundle = await readFile(path.join(extPath, 'content.js'), 'utf8');
    const idx = bundle.indexOf('chrome-extension://');
    console.log(bundle.slice(Math.max(0, idx - 300), idx + 200));
    console.log(')');
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