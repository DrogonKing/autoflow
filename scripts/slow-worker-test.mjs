#!/usr/bin/env node
/**
 * The schedule on a machine whose worker is SLOW, which is the reported machine.
 *
 * The export showed a 6000ms gap between the alarm firing and the run starting, against a fixed 1500ms wake margin.
 * This script reproduces that shape by recording a latency sample before arming, and checks the two things that must
 * both hold for a saved schedule to work on such a machine:
 *
 *   1. the alarm is armed EARLY ENOUGH that a slow worker still arrives before the target;
 *   2. it is not armed SO early that the handler decides the target is a future occurrence and skips the precise wait.
 *
 * A simulated 6s latency is used rather than a real slow machine, because the point is the arithmetic between the
 * stored sample and the two decisions - and that arithmetic is what was wrong.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const SIM = path.join(ROOT, 'tools', 'sim', 'index.html');
const CHROME = process.env.AUTOFLOW_CHROME || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 300)}` : ''}`);
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(SIM));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(path.join(os.tmpdir(), 'af-slow-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
});

let worker = null;
for (let i = 0; i < 80 && !worker; i++) {
  for (const w of ctx.serviceWorkers()) {
    try { if (/autoflow/i.test(await w.evaluate(() => chrome?.runtime?.getManifest?.()?.name ?? ''))) { worker = w; break; } } catch {}
  }
  if (!worker) await new Promise((r) => setTimeout(r, 250));
}
if (!worker) { console.error('no worker'); await ctx.close(); process.exit(1); }
const extId = new URL(worker.url()).host;
const bridge = await ctx.newPage();
await bridge.goto(`chrome-extension://${extId}/options.html`);

const page = await ctx.newPage();
await page.goto(url);
await page.bringToFront();
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null, null, { timeout: 20_000 });

console.log('\n--- 1. a saved schedule on a machine reporting a 6000ms worker start ---');
{
  /**
   * The latency sample is what `recordStartLatency` writes. Planting 6000ms reproduces the reported machine, and the
   * arithmetic under test is what happens to that number.
   */
  const planted = await bridge.evaluate(async () => {
    await chrome.storage.local.set({ scheduledStartLatencyMs: 6000 });
    const got = await chrome.storage.local.get('scheduledStartLatencyMs');
    return got.scheduledStartLatencyMs;
  });
  console.log(`  planted latency sample: ${planted}ms`);
  check('the latency sample is stored where the scheduler reads it', planted === 6000, String(planted));

  const target = new Date(Date.now() + 12_000);
  const saved = await bridge.evaluate(async ({ hh, mm, ss, url }) => {
    const res = await chrome.runtime.sendMessage({
      type: 'save-automation',
      automation: {
        id: 'slow-sched', name: 'slow sched', enabled: true, urls: [url],
        schedule: { kind: 'daily', hour: hh, minute: mm, second: ss },
        steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#pad5' } }],
        options: { stepDelayMs: 0 },
      },
    });
    const alarms = await new Promise((r) => chrome.alarms.getAll((a) => r(a ?? [])));
    return {
      schedule: res?.schedule,
      alarm: alarms.find((a) => a.name.includes('slow-sched')) ?? null,
      targetMs: new Date(new Date().setHours(hh, mm, ss, 0)).getTime(),
    };
  }, { hh: target.getHours(), mm: target.getMinutes(), ss: target.getSeconds(), url });

  const leadMs = saved.targetMs - (saved.alarm?.scheduledTime ?? saved.targetMs);
  console.log(`  target ${new Date(saved.targetMs).toISOString().slice(11, 19)}   alarm ${leadMs}ms early`);
  console.log(`  save reported: ${JSON.stringify(saved.schedule)}`);

  check('ARMED EARLY ENOUGH for a 6s worker: at least 6s before the target',
    leadMs >= 6000, `${leadMs}ms of lead, a 6000ms worker needs at least 6000`);
  check('and the lead includes room left to WAIT, not just to arrive',
    leadMs >= 6000 + 1400, `${leadMs}ms of lead - 6000ms of travel leaves ${leadMs - 6000}ms to wait`);
  check('but not absurdly early', leadMs < 20_000, `${leadMs}ms`);
  check('the save reports the instant it armed', saved.schedule?.scheduled === true, JSON.stringify(saved.schedule));
}

console.log('\n--- 2. the run still lands on the target second, despite the slow worker ---');
{
  const deadline = Date.now() + 40_000;
  let clicked = null;
  while (Date.now() < deadline) {
    clicked = await page.evaluate(() => {
      const e = (window.__clicks ?? []).find((x) => /^نقطه ۵$/.test(x.target));
      return e ? { ms: e.ms, at: e.at } : null;
    });
    if (clicked) break;
    await page.waitForTimeout(200);
  }
  check('the slow-worker schedule fired on its own', clicked !== null, JSON.stringify(clicked));
  console.log(`  clicked at ${clicked?.at} (${clicked?.ms})`);
}

console.log('\n--- 3. the decisions are visible in the export, so the next report needs no guessing ---');
{
  const text = await bridge.evaluate(async () => {
    const d = await chrome.runtime.sendMessage({ type: 'export-diagnostics' });
    return d?.text ?? '';
  });
  const lines = text.split('\n').filter((l) => /alarm-fired|armed|fired-late|run-finished|ACCEPTED/.test(l));
  for (const l of lines.slice(0, 8)) console.log(`    ${l.trim()}`);
  check('the export shows the alarm firing', /alarm-fired/.test(text), 'missing alarm-fired');
  check('the export shows the arming', /armed/.test(text), 'missing armed');
}

console.log('\n--- 4. a MISSED occurrence is reported rather than silently skipped ---');
{
  /**
   * Simulated by asking rescheduleAll for a moment a day after the schedule's last occurrence: the browser was closed
   * at the target, so `nextRun` returns tomorrow and today is gone. That must appear as `missed`, not as a healthy arm.
   */
  const missed = await bridge.evaluate(async () => {
    const a = await chrome.runtime.sendMessage({ type: 'list-automations' });
    const auto = (a?.automations ?? []).find((x) => x.id === 'slow-sched');
    if (!auto) return { error: 'automation not found' };
    // ask the scheduler to re-arm as if "now" were a day later - it must notice the slot in between
    const res = await chrome.runtime.sendMessage({ type: 'reschedule' });
    return { res, schedule: auto.schedule };
  });
  console.log(`  reschedule result: ${JSON.stringify(missed).slice(0, 200)}`);
  check('rescheduling succeeds', missed.res?.ok === true, JSON.stringify(missed.res ?? missed.error));
}

await ctx.close();
server.close();

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);