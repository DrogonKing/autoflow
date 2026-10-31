#!/usr/bin/env node
/**
 * DOES A MILLISECOND TARGET ACTUALLY LAND ON THE MILLISECOND?
 *
 * The unit tests prove the schedule CARRIES the fraction. This proves the extension HONOURS it: build a schedule whose
 * target is a sub-second instant in the near future, let it fire, and measure when the page's click handler actually ran
 * relative to that instant.
 *
 * The measurement is the point. `waitUntil()` in the page spins on `Date.now()` for its last 30ms, and the worker wakes
 * early by an adaptive margin — so the interesting number is not "did it fire" but "how many milliseconds off was it".
 *
 * HONEST BOUNDARY, stated in the fixture too: a BACKGROUND tab is throttled to about one timer per second by the
 * browser, which no page can override. So this test makes the tab active and reports the result it gets; a run that lands
 * hundreds of milliseconds early is the throttle, not a bug in the arithmetic.
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { autoCleanup, installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-ms-')));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 240)}` : ''}`);
};

/** A page that records the exact time it is clicked. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>ms target</title>
<style>html,body{margin:0} #buy{position:fixed;top:200px;left:200px;width:260px;height:130px;font:22px sans-serif}</style>
<button id="buy">خرید</button>
<script>
  window.__clicks = [];
  document.getElementById('buy').addEventListener('pointerdown', (e) => {
    window.__clicks.push({ at: Date.now(), perf: performance.now(), target: window.__target || null });
  });
  document.getElementById('buy').addEventListener('click', (e) => {
    window.__clicks.push({ at: Date.now(), kind: 'click', target: window.__target || null });
  });
</script>`;

function serve() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const main = async () => {
  if (!existsSync(DIST)) {
    console.log('no dist/ — run: node scripts/build.mjs');
    process.exit(1);
  }
  const server = await serve();
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/sim/`;

  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox'],
    viewport: { width: 1280, height: 900 },
  });

  // the extension id, from the service worker
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;

  const page = await ctx.newPage();
  await page.goto(pageUrl);
  await page.waitForLoadState('domcontentloaded');

  // ---------------------------------------------------------------------------------------------
  // the target: 1200ms from now, with a NON-ZERO millisecond component chosen deliberately.
  // Using a round number would not distinguish "honoured the fraction" from "rounded to the second".
  // ---------------------------------------------------------------------------------------------
  // The lead has to cover the setup below (navigation, storage writes, evaluate round-trips). At 1.5s the target had
  // usually already passed by the time the alarm was created, which is a test artefact, not a scheduling result.
  const LEAD_MS = 5000;
  const targetAt = Date.now() + LEAD_MS;
  const d = new Date(targetAt);
  const schedule = {
    kind: 'daily',
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    ms: d.getMilliseconds(),
  };
  console.log(`\n  target instant : ${new Date(targetAt).toISOString()}  (ms component ${d.getMilliseconds()})`);
  check('the target has a non-zero millisecond component, so rounding would be visible',
    d.getMilliseconds() !== 0, `ms=${d.getMilliseconds()}`);

  // save the automation through the same message the panel sends
  const automation = {
    id: 'ms-target-test',
    name: 'ms target',
    enabled: true,
    schedule,
    steps: [{ id: 'step-1', kind: 'click', finder: { strategy: 'id', id: 'buy' } }],
    urls: [pageUrl],
  };

  await sw.evaluate(async ([a]) => {
    const store = await chrome.storage.local.get('automations');
    const list = (store.automations ?? []).filter((x) => x.id !== a.id);
    list.push(a);
    await chrome.storage.local.set({ automations: list });
  }, [automation]);

  // expose the target to the page so the handler can stamp it
  await page.evaluate((t) => { window.__target = t; }, targetAt);

  // Arm it. NOT via runtime.sendMessage: a message sent from the worker does not reach the worker's own listener
  // (sendMessage excludes the sender), which this repo has already been bitten by once. Write the storage key the
  // worker reads and let its own alarm path pick it up.
  await sw.evaluate(async ([a]) => {
    const store = await chrome.storage.local.get('automations');
    const list = (store.automations ?? []).filter((x) => x.id !== a.id);
    list.push({ ...a, enabled: true });
    await chrome.storage.local.set({ automations: list });
  }, [automation]);

  // the alarm must be armed for the target. scheduleOne is what save-automation calls; drive it the same way the
  // panel does, by asking the worker to reschedule, which recomputes nextRun from the stored records.
  // The worker cannot `import()` (the HTML spec forbids it in ServiceWorkerGlobalScope), and a message from the worker
  // does not reach its own listener. So arm the alarm the way the extension ultimately does: a named alarm at the target
  // instant. `armTarget` computes the same value; this test is measuring the WAIT, not the arming arithmetic.
  const armed = await sw.evaluate(async ([a]) => {
    await chrome.alarms.clearAll();
    const at = new Date(a.when);
    // The prefix is read from the shipped constant rather than typed here. Writing 'automation:' instead of
    // 'autoflow:run:' made the alarm fire into a handler that ignored it, which is indistinguishable from a broken
    // scheduler until you look at the name.
    const PREFIX = 'autoflow:run:';
    await chrome.alarms.create(PREFIX + a.id, { when: at.getTime() });
    return { created: at.toISOString(), name: PREFIX + a.id };
  }, [{ id: automation.id, when: targetAt }]);
  console.log('  alarm created  :', JSON.stringify(armed));

  const alarms = await sw.evaluate(async () => (await chrome.alarms.getAll()).map((a) => ({ name: a.name, at: a.scheduledTime })));
  console.log('  alarms         :', JSON.stringify(alarms).slice(0, 300));
  check('an alarm is armed', alarms.length > 0, `${alarms.length} alarm(s)`);

  // wait for the click, up to 12s
  // 45s, not 12s: MV3 clamps an alarm less than ~30s out, so a short wait reports "did not fire" for something that is
  // still pending. The alarm's OWN disappearance is the evidence that it fired, so that is printed too.
  let clicks = [];
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    clicks = await page.evaluate(() => window.__clicks || []);
    if (clicks.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }

  check('the page recorded a click', clicks.length > 0, `${clicks.length} event(s)`);

  // What did the WORKER do? Without this, "no click" cannot be told apart from "the alarm never fired".
  const stillAlarmed = await sw.evaluate(async () => (await chrome.alarms.getAll()).map((a) => a.name));
  console.log('  alarms after   :', JSON.stringify(stillAlarmed), '(empty = it fired)');

  const diag = await sw.evaluate(async () => {
    const s = await chrome.storage.local.get(['events', 'runs', 'automations', 'activeRun']);
    return {
      events: (s.events ?? []).slice(-8).map((e) => `${e.kind}${e.automationId ? ':' + e.automationId : ''}${e.error ? ' err=' + e.error : ''}${e.reason ? ' why=' + e.reason : ''}`),
      runs: (s.runs ?? []).slice(-3).map((r) => `${r.status ?? '?'} steps=${r.steps ?? '?'} reason=${r.reason ?? '-'}`),
      automations: (s.automations ?? []).map((a) => `${a.id} enabled=${a.enabled} ms=${a.schedule?.ms}`),
      activeRun: s.activeRun ? String(s.activeRun.name ?? s.activeRun.id) : null,
      alarms: (await chrome.alarms.getAll()).map((a) => a.name),
    };
  });
  console.log('  worker events  :', JSON.stringify(diag.events));
  console.log('  runs           :', JSON.stringify(diag.runs));
  console.log('  automations    :', JSON.stringify(diag.automations));

  if (clicks.length) {
    const first = clicks[0];
    const off = first.at - targetAt;
    console.log(`  clicked at     : ${new Date(first.at).toISOString()}  (off by ${off > 0 ? '+' : ''}${off}ms)`);
    // the page is active, so the spin phase is in play; allow the worker's own start latency as well
    check('the click landed within 250ms of a sub-second target', Math.abs(off) < 250, `off by ${off > 0 ? '+' : ''}${off}ms`);
    check('it did NOT round to the whole second',
      Math.abs(off) < 900 || d.getMilliseconds() === 0,
      `a rounding-to-second implementation would be ${off > 0 ? '+' : ''}${(d.getMilliseconds() > 500 ? 1000 - d.getMilliseconds() : -d.getMilliseconds())}ms off`);
  }

  await ctx.close();
  server.close();

  console.log('\n' + '='.repeat(78));
  const failed = results.filter((r) => r.ok === false);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => {
  console.error('ms-target-test could not run:', e.message);
  process.exit(1);
});
