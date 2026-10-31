#!/usr/bin/env node
/**
 * Does a SAVED schedule actually fire, and does the click land on the target second?
 *
 * This is the report the two exports were about: "I set a time, saved it, and it did not activate; but Run now did
 * everything at once. I set another time and again it did not activate."
 *
 * Two separate failures were suspected from the exports and are tested separately here:
 *
 *   1. no alarm at all, because saving never armed one - the export shows a stale alarm from an earlier session (due
 *      01:20:01.5, already in the past) and nothing armed for the 01:21:03 target;
 *   2. a worker wake margin of a fixed 1500ms against a measured 6000ms start latency, so the worker arrives after the
 *      target and the precise wait clamps to "now" and fires a best-effort shot.
 *
 * Both must be fixed for a saved schedule to work, so both are asserted here against the same real run.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 300)}` : ''}`);
};

// the test field served over http, because a precise schedule needs a real tab and file:// grants vary by launch
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(SIM));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-sched-')));
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
const tabId = await bridge.evaluate(async () => (await chrome.tabs.query({}))
  .find((t) => (t.url ?? '').startsWith('http://127.0.0.1'))?.id ?? null);
console.log(`\n  page ${url}  tab ${tabId}`);

console.log('\n--- 1. SAVING a schedule with a second arms an alarm ---');
let armed = null;
{
  // a target ~14 seconds ahead, with a second, which is the case that never fired
  const target = new Date(Date.now() + 14_000);
  const hh = target.getHours(), mm = target.getMinutes(), ss = target.getSeconds();

  const saved = await bridge.evaluate(async ({ tabId, hh, mm, ss, url }) => {
    const res = await chrome.runtime.sendMessage({
      type: 'save-automation',
      automation: {
        id: 'sched-live', name: 'sched live', enabled: true, urls: [url],
        schedule: { kind: 'daily', hour: hh, minute: mm, second: ss },
        steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#pad3' } }],
        options: { stepDelayMs: 0 },
      },
    });
    if (!res?.ok) return { error: res?.error ?? 'save failed' };
    const alarms = await new Promise((r) => chrome.alarms.getAll((a) => r(a ?? [])));
    return {
      schedule: res.schedule,
      alarms: alarms.map((a) => ({ name: a.name, at: a.scheduledTime })).filter((a) => a.name.includes('sched-live')),
      wantedLocal: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
      // computed HERE, from the same h/m/s the save used, rather than closing over the node-side Date - which is not
      // available inside page/bridge.evaluate
      targetMs: new Date(new Date().setHours(hh, mm, ss, 0)).getTime(),
    };
  }, { tabId, hh, mm, ss, url });

  armed = saved;
  console.log(`  target ${saved.wantedLocal}   save returned: ${JSON.stringify(saved.schedule)}`);
  console.log(`  alarms now: ${JSON.stringify(saved.alarms)}`);

  check('saving reports the schedule it armed', saved.schedule?.scheduled === true, JSON.stringify(saved.schedule));
  check('and an alarm actually EXISTS for it', (saved.alarms ?? []).length === 1, JSON.stringify(saved.alarms));
  check('the alarm is in the future, not a stale one', (saved.alarms?.[0]?.at ?? 0) > Date.now(), String(saved.alarms?.[0]?.at));
}

console.log('\n--- 2. the saved schedule fires on its own, and the click lands on the second ---');
{
  // wait for the alarm to fire and the run to complete
  const deadline = Date.now() + 45_000;
  let fired = false;
  let pad3 = null;
  while (Date.now() < deadline) {
    pad3 = await page.evaluate(() => {
      const el = document.getElementById('pad3');
      const c = Number(el?.querySelector('[data-count]')?.textContent ?? '0');
      return { count: c, when: el?.querySelector('[data-when]')?.textContent ?? null };
    });
    if (pad3.count > 0) { fired = true; break; }
    await page.waitForTimeout(250);
  }

  console.log(`  pad3 clicked: ${fired}   (${JSON.stringify(pad3)})`);
  check('the saved schedule fired WITHOUT Run now being pressed', fired === true, JSON.stringify(pad3));

  // the whole point: the click's own timestamp against the target second
  const target = armed.targetMs;
  const clickMs = await page.evaluate(() => {
    const e = (window.__clicks ?? []).find((x) => /^نقطه ۳$/.test(x.target));
    return e?.ms ?? null;
  });
  const delta = clickMs === null ? null : clickMs - target;
  console.log(`  target epoch ${target}  click epoch ${clickMs}  delta ${delta}ms`);
  check('the click was recorded at all', clickMs !== null, String(clickMs));
  check('and landed within a second of the target second', Math.abs(delta ?? 99_999) < 1000, `${delta}ms`);

  // the export must be able to ANSWER whether the alarm fired - that was impossible before
  const diag = await bridge.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'export-diagnostics' })));
  const text = diag?.text ?? '';
  console.log('  events in the export:');
  for (const line of text.split('\n').filter((l) => /alarm-fired|armed|ACCEPTED|finished/.test(l)).slice(0, 8)) {
    console.log(`    ${line.trim()}`);
  }
  check('the export records the alarm firing', /alarm-fired/.test(text), 'no alarm-fired line');
  check('the export records the alarm being armed', /armed/.test(text), 'no armed line');
}

await ctx.close();
server.close();

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);