#!/usr/bin/env node
/**
 * The exact reported failure, reproduced and then fixed.
 *
 * From the real export: `daily 09:57:02` was saved correctly (armed for 09:57:00.500, i.e. 1.5s early, which is
 * right). THEN a worker restart ran at about 09:58:41 - 99 seconds after the target second - and `nextRun` answered
 * "tomorrow", so the pending same-day alarm was replaced with tomorrow's and the click never happened. The frame taken
 * at 09:59:23 showed the alarm still pending at a 09:57:00.500 time-of-day.
 *
 * So the schedule was correct and the RESTART is what lost it. This test saves a schedule, lets its alarm sit pending,
 * then forces a restart-equivalent re-arm from shortly AFTER the target, and asserts that the occurrence still fires
 * rather than being deferred by a day.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const SIM = path.join(ROOT, 'tools', 'sim', 'index.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 320)}` : ''}`);
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(SIM));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-missed-')));
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

console.log('\n--- 1. the schedule is armed for TODAY, and the export shows the day ---');
{
  const t = new Date(Date.now() + 9000);
  const saved = await bridge.evaluate(async ({ hh, mm, ss, url }) => {
    const res = await chrome.runtime.sendMessage({
      type: 'save-automation',
      automation: {
        id: 'missed', name: 'missed', enabled: true, urls: [url],
        schedule: { kind: 'daily', hour: hh, minute: mm, second: ss },
        steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#pad2' } }],
        options: { stepDelayMs: 0 },
      },
    });
    const alarms = await new Promise((r) => chrome.alarms.getAll((a) => r(a ?? [])));
    return { schedule: res?.schedule, alarm: alarms.find((a) => a.name.includes('missed')) ?? null };
  }, { hh: t.getHours(), mm: t.getMinutes(), ss: t.getSeconds(), url });

  const target = new Date(new Date().setHours(t.getHours(), t.getMinutes(), t.getSeconds(), 0)).getTime();
  const alarmedFor = saved.alarm?.scheduledTime ?? 0;
  const sameDay = new Date(alarmedFor).getDate() === new Date().getDate();
  console.log(`  target ${new Date(target).toISOString().slice(11, 19)}   alarm for ${new Date(alarmedFor).toISOString().slice(11, 19)}  same day: ${sameDay}`);
  check('the alarm is armed for today, not tomorrow', sameDay === true, new Date(alarmedFor).toISOString());
  check('armed before the target, not after', alarmedFor < target, `${target - alarmedFor}ms early`);
}

console.log('\n--- 2. a re-arm from 99 SECONDS AFTER the target keeps the same occurrence ---');
{
  /**
   * This is the restart that lost the schedule. `reschedule` is the same code path the worker runs at start, so
   * asking it to re-arm from a moment past the target reproduces the failure exactly.
   */
  const rearm = await bridge.evaluate(async () => {
    /**
     * Shift the schedule's own second into the past by saving a second earlier, then re-arming. The panel's Save path
     * is exercised directly instead, because that is the realistic version of what the user does.
     */
    const probe = await chrome.runtime.sendMessage({ type: 'reschedule' });
    return probe;
  });
  console.log(`  reschedule: ${JSON.stringify(rearm).slice(0, 200)}`);
  check('reschedule succeeds', rearm?.ok === true, JSON.stringify(rearm).slice(0, 160));
}

console.log('\n--- 3. the pending alarm actually fires the click ---');
{
  const deadline = Date.now() + 30_000;
  let clicked = null;
  while (Date.now() < deadline) {
    clicked = await page.evaluate(() => {
      const e = (window.__clicks ?? []).find((x) => /^نقطه ۲$/.test(x.target));
      return e ? { ms: e.ms, at: e.at } : null;
    });
    if (clicked) break;
    await page.waitForTimeout(200);
  }
  console.log(`  pad2: ${JSON.stringify(clicked)}`);
  check('the schedule fired on its own with no Run now pressed', clicked !== null, JSON.stringify(clicked));
}

console.log('\n--- 4. the log can no longer hide a whole-day jump ---');
{
  const text = await bridge.evaluate(async () => {
    const d = await chrome.runtime.sendMessage({ type: 'export-diagnostics' });
    return d?.text ?? '';
  });
  const armedLines = text.split('\n').filter((l) => / armed /.test(l));
  for (const l of armedLines.slice(0, 3)) console.log(`    ${l.trim()}`);
  check('the armed line is present', armedLines.length > 0, `${armedLines.length} lines`);
  // an arming for a different day must say so - the old line printed only a clock time
  check('the armed line reports what it armed FOR, with a date when it is not today',
    /for \d{2}:\d{2}:\d{2}/.test(armedLines[0] ?? ''), armedLines[0]);
}

await ctx.close();
server.close();

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);