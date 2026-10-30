#!/usr/bin/env node
/**
 * Five automations aimed at the SAME second. All five must click.
 *
 * This reproduces the reported failure: "of the five I set, two did not register when their time came". Five
 * separate automations, each with its own target point, each scheduled for the same wall-clock second - which is
 * exactly what an order window looks like, and exactly what the old code could not do:
 *
 *   - they all arrive together, and `startAutomation` refused while another run held the slot, so the second and
 *     later ones were rejected. That refusal was recorded as a run with reason `step-error`, so a run that never
 *     happened looked like a run that failed.
 *   - if the alarm fired late, the code saw a schedule whose next occurrence was in the future and dropped the run
 *     without a trace.
 *
 * The check is not "the run object exists" but "five clicks were logged by the PAGE", because the page is the
 * only thing that knows a click really happened.
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

const profile = mkdtempSync(path.join(os.tmpdir(), 'af-multi-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox',
    '--disable-dev-shm-usage', '--allow-file-access-from-files',
    '--disable-features=DisableLoadExtensionCommandLineSwitch'],
});

let worker = null;
for (let i = 0; i < 60 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 300));
}
if (!worker) { console.error('no worker'); await ctx.close(); process.exit(1); }
worker.on('console', (m) => { if (/autoflow/.test(m.text())) console.log(`  [worker] ${m.text()}`); });
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

// a target second far enough away that arming cannot race the test, close enough to keep the run short
const now = Date.now();
const target = new Date(Math.ceil((now + 16_000) / 1000) * 1000);
const hh = target.getHours(), mm = target.getMinutes(), ss = target.getSeconds();
console.log(`  all five scheduled for ${target.toLocaleTimeString()} (second ${ss})\n`);

const armed = await bridge.evaluate(async ({ tabId, hh, mm, ss, pageUrl }) => {
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const out = [];
  for (const [i, id] of ids.entries()) {
    await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
      /**
       * THE PAGE IS NAMED, because a SCHEDULED run must not guess which tab it means.
       *
       * The old test saved `urls: []` and relied on the worker falling back to the active tab. That fallback is what
       * delivered clicks to whatever page the user happened to have in front (B5), so it is gone for scheduled runs -
       * and this test, which is a scheduled run five times over, has to say where it wants its clicks. `file://` is an
       * actionable scheme for the matcher, and the page is the simulator.
       */
      id, name: `multi ${i + 1}`, enabled: true, urls: [pageUrl],
      steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: `#pad${i + 1}` } }],
      schedule: { kind: 'daily', hour: hh, minute: mm, second: ss },
      options: { stepDelayMs: 0, focusBeforePrecise: false },
    } });
    const r = await chrome.runtime.sendMessage({ type: 'schedule-one', automationId: id });
    out.push({ id, ...r });
  }
  return out;
}, { tabId, hh, mm, ss, pageUrl: `file://${SIM}` });

for (const a of armed) {
  console.log(`  ${a.id}: scheduled=${a.scheduled} at=${a.at} target=${a.target} precise=${a.precise}`);
}
check('all five are armed', armed.every((a) => a.scheduled === true), `${armed.filter((a) => a.scheduled).length}/5`);

// wait past the target
const waitUntil = target.getTime() + 20_000;
while (Date.now() < waitUntil) {
  const n = await page.evaluate(() => window.__clicks?.length ?? 0).catch(() => 0);
  if (n >= 5) break;
  await new Promise((r) => setTimeout(r, 250));
}

const log = await page.evaluate(() => (window.__clicks ?? []).map((e) => ({ at: e.at, target: e.target, delta: e.delta })));
console.log(`\n  clicks logged by the page: ${log.length}`);
for (const e of log) console.log(`    ${e.at}   ${e.target}   +${e.delta ?? 0}ms`);

const targets = new Set(log.map((e) => e.target));
console.log('');
check('all five clicked', log.length >= 5, `${log.length}`);
check('five DIFFERENT points were clicked', targets.size === 5, [...targets].join(', '));
check('each of the five points was clicked exactly once',
  log.length === 5 && targets.size === 5, `${log.length} clicks over ${targets.size} points`);

// what the run history says, which is where the old bug hid a dropped run as a failed one
const runs = await bridge.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'list-runs' }))?.runs ?? []);
const mine = runs.filter((r) => String(r.automationId ?? '').startsWith('m'));
console.log(`  run records: ${mine.length}`);
for (const r of mine) console.log(`    ${r.automationId}  ${r.reason}  steps=${r.steps}  ${r.error?.message ?? ''}`);
const failedReasons = mine.filter((r) => r.reason === 'step-error' && /already in progress/i.test(r.error?.message ?? ''));
check('no run was rejected for "already in progress"', failedReasons.length === 0,
  failedReasons.map((r) => r.error?.message).join(' | '));

await ctx.close();

console.log('\n' + '='.repeat(76));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);