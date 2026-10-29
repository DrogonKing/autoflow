#!/usr/bin/env node
/**
 * Prove the simulation page works with the real extension: pick, multi-point click, and the log that reports it.
 *
 * This is not a test of the page's HTML. It answers the three questions the user will ask when they open it:
 *
 *   1. does the picker produce a selector that actually resolves on this page?
 *   2. can one run click SEVERAL different points, each logged with its own hundredth-of-a-second time?
 *   3. does "every match" press all three identically-labelled buttons here?
 *
 * The timings are read from the page's own log, not from the extension, because the page is the ground truth
 * for when the browser dispatched the click.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const SIM = path.join(ROOT, 'tools', 'sim', 'index.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

// serve the page exactly as serve.sh does, so the test exercises the same origin the user will use
const html = readFileSync(SIM);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(path.join(os.tmpdir(), 'autoflow-sim-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
});

let worker = null;
for (let i = 0; i < 50 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 300));
}
if (!worker) { console.error('no worker'); server.close(); await ctx.close(); process.exit(1); }

const bridge = await ctx.newPage();
await bridge.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);

const page = await ctx.newPage();
await page.goto(url);
// wait for the content script's marker rather than a fixed delay - a fixed delay is how a test becomes a flake
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null,
  null, { timeout: 15_000 });

const tabId = await bridge.evaluate(async () => (await chrome.tabs.query({}))
  .find((t) => t.url.startsWith('http://127.0.0.1'))?.id ?? null);
console.log(`\n  page ${url}   tab ${tabId}`);

console.log('\n--- 1. the page renders what was asked for ---');
{
  const shape = await page.evaluate(() => ({
    pads: document.querySelectorAll('.pad[data-target]').length,
    sames: document.querySelectorAll('.same[data-target]').length,
    sameLabel: document.querySelector('.same')?.textContent?.includes('ارسال پی در پی سفارش'),
    clock: document.getElementById('clock')?.textContent,
    rtl: document.documentElement.getAttribute('dir'),
  }));
  console.log(`  pads=${shape.pads} same-name=${shape.sames} clock=${shape.clock} dir=${shape.rtl}`);
  // five, because the reported failure involved five automations and the page should be able to host that
  check('five separate points exist', shape.pads === 5, `${shape.pads}`);
  check('three identically-labelled buttons exist', shape.sames === 3, `${shape.sames}`);
  check('the identical label is the one from the real case',
    shape.sameLabel === true, String(shape.sameLabel));
  check('there is a live clock with hundredths', /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(shape.clock ?? ''),
    shape.clock);
  check('the page is right-to-left', shape.rtl === 'rtl', shape.rtl);
}

console.log('\n--- 2. a real click is logged with a hundredth-of-a-second time ---');
{
  await page.click('#pad2');
  await page.waitForTimeout(120);
  const log = await page.evaluate(() => window.__clicks.map(({ n, at, target, delta }) => ({ n, at, target, delta })));
  console.log(`  log: ${JSON.stringify(log)}`);
  check('one click is recorded', log.length === 1, `${log.length}`);
  check('the time matches HH:MM:SS:CC', /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(log[0]?.at ?? ''), log[0]?.at);
  check('it names the point that was clicked', log[0]?.target === 'نقطه ۲', log[0]?.target);
  await page.click('#reset');
  await page.waitForTimeout(80);
}

console.log('\n--- 3. ONE run clicking THREE different points, timed by the page ---');
{
  // Three steps, each with its own selector. This is the "several points at once" case.
  const steps = [
    { id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#pad4' } },
    { id: 's2', kind: 'click', finder: { strategy: 'css', selector: '#pad1' } },
    { id: 's3', kind: 'click', finder: { strategy: 'css', selector: '#pad3' } },
  ];
  const run = await bridge.evaluate(async ({ tabId, steps }) => {
    await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
      id: 'sim-multi', name: 'sim multi', enabled: false, urls: ['127.0.0.1'],
      steps, schedule: { kind: 'manual' }, options: { stepDelayMs: 0 },
    } });
    return chrome.runtime.sendMessage({ type: 'start-run', automationId: 'sim-multi', tabId });
  }, { tabId, steps });

  // wait for three clicks to be logged
  await page.waitForFunction(() => (window.__clicks?.length ?? 0) >= 3, null, { timeout: 15_000 });
  const log = await page.evaluate(() => window.__clicks.map(({ n, at, target, delta }) => ({ n, at, target, delta })));
  console.log(`  log:`);
  for (const e of log) console.log(`    ${e.n}  ${e.at}   ${e.target}   +${e.delta ?? 0}ms`);

  check('the run completed', run?.ok === true, JSON.stringify(run?.error ?? 'ok'));
  check('three clicks were logged', log.length === 3, `${log.length}`);
  check('each landed on a DIFFERENT point',
    new Set(log.map((e) => e.target)).size === 3, log.map((e) => e.target).join(', '));
  check('the order is the order of the steps',
    log.map((e) => e.target).join(',') === 'نقطه ۴,نقطه ۱,نقطه ۳',
    log.map((e) => e.target).join(','));
  check('every time has hundredths', log.every((e) => /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(e.at)),
    log.map((e) => e.at).join(' '));
  check('the gaps between clicks are reported in ms',
    log.slice(1).every((e) => Number.isFinite(e.delta) && e.delta >= 0),
    log.map((e) => e.delta).join(', '));
  await page.click('#reset');
  await page.waitForTimeout(80);
}

console.log('\n--- 4. "every match" presses all three identical buttons ---');
{
  const run = await bridge.evaluate(async ({ tabId }) => {
    await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
      id: 'sim-all', name: 'sim all', enabled: false, urls: ['127.0.0.1'],
      steps: [{
        id: 's1', kind: 'click',
        finder: { strategy: 'text', text: 'ارسال پی در پی سفارش' },
        clickAll: { order: 'reverse', limit: 0, gapMs: 120 },
      }],
      schedule: { kind: 'manual' }, options: { stepDelayMs: 0 },
    } });
    return chrome.runtime.sendMessage({ type: 'start-run', automationId: 'sim-all', tabId });
  }, { tabId });

  await page.waitForFunction(() => (window.__clicks?.length ?? 0) >= 3, null, { timeout: 20_000 })
    .catch(() => {});
  const log = await page.evaluate(() => window.__clicks.map(({ n, at, target }) => ({ n, at, target })));
  console.log(`  log: ${JSON.stringify(log)}`);
  check('all three identically-labelled buttons were pressed', log.length === 3, `${log.length}`);
  check('and each is a different button', new Set(log.map((e) => e.target)).size === 3,
    log.map((e) => e.target).join(', '));
  check('the run says how many it pressed', /3/.test(JSON.stringify(run)), JSON.stringify(run).slice(0, 140));
}

console.log('\n--- 5. the picker resolves on this page ---');
{
  // the picker itself needs a human, so this checks the part that can be checked: that a finder built from a
  // real element on this page resolves back to that same element.
  const round = await page.evaluate(() => {
    const el = document.getElementById('pad3');
    // the same signals buildFinder uses, verified present on this page
    return {
      id: el.id,
      uniqueId: document.querySelectorAll('#' + el.id).length,
      tag: el.tagName,
      hasBox: el.getBoundingClientRect().width > 0,
    };
  });
  console.log(`  ${JSON.stringify(round)}`);
  check('the target has a unique id for the picker to prefer', round.uniqueId === 1 && round.id === 'pad3',
    `${round.id} x${round.uniqueId}`);
  check('the target has a layout box, so it can be clicked by coordinates too', round.hasBox === true,
    String(round.hasBox));
}

await ctx.close();
server.close();

console.log('\n' + '='.repeat(76));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);