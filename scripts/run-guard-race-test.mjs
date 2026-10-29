#!/usr/bin/env node
/**
 * Is the "one run at a time" guard a race?
 *
 * FOUND BY READING, then confirmed by reasoning about a single-threaded event loop, which is easy to get wrong:
 *
 *   if (activeRun) throw ...          <-- CHECK
 *   const automation = await ...      <-- SUSPENDS here
 *   const settings = await ...        <-- SUSPENDS again
 *   activeRun = { ... }               <-- SET, three awaits later
 *
 * Between the check and the set the function yields. A second call that arrives in that window also sees
 * `activeRun === null`, also passes the check, and also proceeds - so TWO runs start, and the second overwrites
 * the first's bookkeeping. That is a lost run: seven of eight clicked, and one never did.
 *
 * This file reproduces it with the real function, not a model of it. Two concurrent calls; exactly one must
 * start and the other must be refused. Against the old code this assertion fails.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

const profile = mkdtempSync(path.join(os.tmpdir(), 'af-race-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
});

let worker = null;
for (let i = 0; i < 60 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 300));
}
if (!worker) { console.error('no worker'); await ctx.close(); process.exit(1); }
const extId = new URL(worker.url()).host;

const bridge = await ctx.newPage();
await bridge.goto(`chrome-extension://${extId}/options.html`);

const page = await ctx.newPage();
await page.goto(`file://${SIM}`);
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null,
  null, { timeout: 15_000 });
const tabId = await bridge.evaluate(async () => (await chrome.tabs.query({}))
  .find((t) => (t.url ?? '').startsWith('file://'))?.id ?? null);
console.log(`\n  tab ${tabId}`);

// two automations, each with a short wait then a click, so the first is certainly still running when the second
// is fired at it
await bridge.evaluate(async () => {
  for (const [i, pad] of [[1, '#pad1'], [2, '#pad2']]) {
    await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
      id: `race${i}`, name: `race${i}`, enabled: false, urls: [],
      steps: [
        { id: 'w', kind: 'wait', ms: 700 },
        { id: 'c', kind: 'click', finder: { strategy: 'css', selector: pad } },
      ],
      schedule: { kind: 'manual' }, options: { stepDelayMs: 0 },
    } });
  }
});

console.log('\n--- two start-run calls issued in the SAME tick ---');
{
  const outcome = await bridge.evaluate(async ({ tabId }) => {
    // both sent without awaiting the first: this is the exact shape of two alarms arriving together
    const [a, b] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'start-run', automationId: 'race1', tabId }),
      chrome.runtime.sendMessage({ type: 'start-run', automationId: 'race2', tabId }),
    ]);
    return { a, b };
  }, { tabId });

  const started = [outcome.a, outcome.b].filter((r) => r?.ok === true).length;
  const refused = [outcome.a, outcome.b].filter((r) => r?.ok === false).length;
  console.log(`  first : ${JSON.stringify(outcome.a).slice(0, 120)}`);
  console.log(`  second: ${JSON.stringify(outcome.b).slice(0, 120)}`);
  check('exactly ONE of two concurrent runs starts', started === 1, `${started} started, ${refused} refused`);
  check('the other is refused with a clear reason, not started', refused === 1,
    `${refused} refused`);

  // let the one that did start finish, and see what the page logged
  await page.waitForTimeout(3000);
  const log = await page.evaluate(() => (window.__clicks ?? []).map((e) => e.target));
  console.log(`  clicks logged: ${JSON.stringify(log)}`);
  check('exactly one click happened, so no run was silently overlapped', log.length === 1,
    `${log.length} clicks: ${log.join(', ')}`);
}

console.log('\n--- a burst of eight, as in the report: SCHEDULED starts must queue, not be refused ---');
{
  await bridge.evaluate(async ({ tabId }) => {
    for (let i = 1; i <= 8; i++) {
      await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
        id: `burst${i}`, name: `burst${i}`, enabled: false, urls: [],
        steps: [{ id: 'c', kind: 'click', finder: { strategy: 'css', selector: `#pad${(i % 5) + 1}` } }],
        schedule: { kind: 'manual' }, options: { stepDelayMs: 0 },
      } });
    }
  }, { tabId });

  // MANUAL bursts are refused: a person pressing Run twice can see what is happening.
  const burst = await bridge.evaluate(async ({ tabId }) => {
    const calls = [];
    for (let i = 1; i <= 8; i++) {
      calls.push(chrome.runtime.sendMessage({ type: 'start-run', automationId: `burst${i}`, tabId }));
    }
    const out = await Promise.all(calls);
    return out.map((r) => (r?.ok ? 'ok' : 'refused'));
  }, { tabId });

  const ok = burst.filter((x) => x === 'ok').length;
  console.log(`  eight manual starts issued together: ${burst.join(', ')}`);
  check('only one manual burst start is accepted', ok === 1, `${ok} started`);

  // SCHEDULED starts queue. This is the case that matters: eight automations on one second.
  // use the page's OWN reset, not just clearing the array: the per-point counters and last-click times are what
  // the assertions read, and clearing the array alone leaves them showing the previous section's clicks
  await page.click('#reset');
  await page.waitForTimeout(150);
  const cleared = await page.evaluate(() => window.__clicks.length);
  check('the page log is cleared before the burst', cleared === 0, `${cleared} left`);
  const scheduled = await bridge.evaluate(async ({ tabId }) => {
    const calls = [];
    for (let i = 1; i <= 8; i++) {
      calls.push(chrome.runtime.sendMessage({
        type: 'start-run', automationId: `burst${i}`, tabId, trigger: 'schedule',
      }));
    }
    const out = await Promise.all(calls);
    return out.map((r) => (r?.ok ? 'ok' : String(r?.error ?? 'refused')));
  }, { tabId });
  const accepted = scheduled.filter((x) => x === 'ok').length;
  console.log(`  eight SCHEDULED starts issued together: ${accepted} accepted, ${8 - accepted} refused`);
  if (accepted < 8) console.log(`    ${scheduled.filter((x) => x !== 'ok').slice(0, 2).join(' | ')}`);
  check('all eight scheduled starts are accepted and queued', accepted === 8, `${accepted}/8`);

  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => (window.__clicks ?? []).map((e) => e.target));
  console.log(`  clicks after the queue drained: ${after.length}`);
  check('every queued run actually clicked', after.length === 8, `${after.length} clicks`);
}

await ctx.close();

console.log('\n' + '='.repeat(76));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);