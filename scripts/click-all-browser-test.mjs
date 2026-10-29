#!/usr/bin/env node
/**
 * Does "every match" actually press all ten, on a page where the list shrinks as you press?
 *
 * This is the feature's real test. The unit tests prove the ORDER and the STOPPING RULE; only a live DOM can
 * show that re-resolving between clicks really reaches all ten rather than the first one ten times.
 *
 * The fixture page removes each button when it is pressed, which is what a live order list does. That is
 * exactly the case an implementation that captures a NodeList once gets wrong: after the first press the
 * remaining indices have shifted, so index 8 no longer points at the ninth button.
 *
 * Three runs against the same page, because the claims are different:
 *   1. every match ON   -> all ten pressed, each exactly once
 *   2. every match OFF  -> exactly one pressed (the behaviour being fixed)
 *   3. a limit of 3     -> exactly three, and reported as such
 */
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const FIXTURE = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'ten-buttons.html')).href;
const CHROME = process.env.AUTOFLOW_CHROMIUM ||
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

const profile = mkdtempSync(path.join(os.tmpdir(), 'autoflow-all-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--files-access-allow-file-access',   // file:// pages need this for the content script to inject
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ],
});

let worker = null;
{
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !worker) {
    for (const w of ctx.serviceWorkers()) {
      try {
        if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; }
      } catch { /* not ours */ }
    }
    if (!worker) await new Promise((r) => setTimeout(r, 300));
  }
}
if (!worker) { console.error('the service worker never started'); await ctx.close(); process.exit(1); }
const extensionId = new URL(worker.url()).host;

/**
 * Ask the worker to run one step on a page, and return what happened.
 *
 * The step is sent through the worker's own message surface rather than by driving the UI, so the test fails
 * for product reasons rather than for a missing button in the panel.
 */
async function runOnPage(step, { reset = true } = {}) {
  const page = await ctx.newPage();
  await page.goto(FIXTURE);

  /**
   * Wait until the CONTENT SCRIPT is demonstrably present, not for a fixed number of milliseconds.
   *
   * `page.goto` resolves when the document loads; the extension injects afterwards. Sending a step in that gap
   * fails with "Could not establish connection. Receiving end does not exist", which is indistinguishable from a
   * product failure - it made this test report 1 failure out of 12 on one run and pass on the next. The content
   * script sets `data-autoflow-content` on the document element, so the honest wait is for that marker.
   */
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-autoflow-content') !== null,
    null, { timeout: 15_000 },
  );

  const tabId = await worker.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t?.id ?? null;
  });
  if (reset) await page.evaluate(() => { window.__presses = []; window.__remaining = [1,2,3,4,5,6,7,8,9,10]; location.reload(); });
  await page.waitForTimeout(400);

  const res = await worker.evaluate(async ({ step, tabId }) => {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'perform-step', step });
      return { ok: true, r: JSON.parse(JSON.stringify(r ?? null)) };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }, { step, tabId });

  await page.waitForTimeout(600);
  const presses = await page.evaluate(() => window.__presses ?? []);
  const remaining = await page.evaluate(() => window.__remaining ?? []);
  await page.close();
  return { res, presses, remaining };
}

const clickStep = (extra) => ({
  id: 's1', kind: 'click',
  finder: { strategy: 'css', selector: 'button.buy' },
  button: 'left', clickCount: 1,
  ...extra,
});

// ---- 1. every match ON
console.log('\n--- 1. every match ON: the same ten, each once ---');
{
  const { res, presses, remaining } = await runOnPage(clickStep({
    clickAll: { order: 'reverse', limit: 0, gapMs: 80 },
  }));
  console.log(`  presses: ${JSON.stringify(presses)}`);
  console.log(`  remaining: ${remaining.length}`);
  if (!res.ok) console.log(`  error: ${res.error}`);

  check('the step ran', res.ok === true, res.error || 'ok');
  check('all ten were pressed', presses.length === 10, `pressed ${presses.length}: ${JSON.stringify(presses)}`);
  check('nothing was pressed twice', new Set(presses).size === presses.length,
    `distinct: ${new Set(presses).size} of ${presses.length}`);
  check('every button id 1..10 was pressed exactly once',
    JSON.stringify([...presses].sort((a, b) => a - b)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    JSON.stringify([...presses].sort((a, b) => a - b)));
  check('the page is empty afterwards', remaining.length === 0, `remaining ${remaining.length}`);
  check('the step reported a count of ten', /10/.test(JSON.stringify(res.r)),
    JSON.stringify(res.r));
}

// ---- 2. every match OFF: the bug being fixed
console.log('\n--- 2. every match OFF: exactly one, which was the reported behaviour ---');
{
  const { res, presses } = await runOnPage(clickStep({ clickAll: null }));
  console.log(`  presses: ${JSON.stringify(presses)}`);
  check('exactly one was pressed', presses.length === 1, `pressed ${presses.length}`);
  check('and it was the FIRST in the DOM', presses[0] === 1, JSON.stringify(presses));
  check('the step ran', res.ok === true, res.error || 'ok');
}

// ---- 3. a limit
console.log('\n--- 3. a limit of 3: exactly three, reported as three ---');
{
  const { res, presses, remaining } = await runOnPage(clickStep({
    clickAll: { order: 'reverse', limit: 3, gapMs: 80 },
  }));
  console.log(`  presses: ${JSON.stringify(presses)}`);
  console.log(`  remaining: ${remaining.length} -> ${JSON.stringify(remaining)}`);
  check('exactly three were pressed', presses.length === 3, `pressed ${presses.length}: ${JSON.stringify(presses)}`);
  check('the rest are untouched', remaining.length === 7, `remaining ${remaining.length}`);
  check('the step reported three', /3/.test(JSON.stringify(res.r)), JSON.stringify(res.r));
}

await ctx.close();

console.log('\n' + '='.repeat(74));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);
