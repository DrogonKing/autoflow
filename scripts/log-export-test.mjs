#!/usr/bin/env node
/**
 * Both export buttons, exercised for real, because a broken export button is worse than none: it is the thing the
 * user is relying on to hand over evidence of a bug that has resisted three fixes.
 *
 * Checks:
 *   1. the test page's CSV contains one row per click, with a header that names the units
 *   2. the test page's full report names the targets that were NOT clicked (the actual question)
 *   3. the panel's Log tab exists and produces a text export containing the decision trail
 *   4. the export includes the page's own click log, read through the DOM because worlds are isolated
 *   5. the version is in the file, so a report cannot arrive against an unknown build
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
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 200)}` : ''}`);
};

const profile = mkdtempSync(path.join(os.tmpdir(), 'af-log-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  acceptDownloads: true,
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
worker.on('console', (m) => { if (/ERROR|error/i.test(m.text())) console.log(`  [worker] ${m.text().slice(0, 160)}`); });
const extId = new URL(worker.url()).host;
const version = await worker.evaluate(() => chrome.runtime.getManifest().version);

const page = await ctx.newPage();
await page.goto(`file://${SIM}`);
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null,
  null, { timeout: 15_000 });
const tabId = await worker.evaluate(async () => (await chrome.tabs.query({}))
  .find((t) => (t.url ?? '').startsWith('file://'))?.id ?? null);

console.log(`\n  extension ${version}   tab ${tabId}\n`);

// click twice by hand and once through the extension, so the log has both kinds of entry
await page.click('#pad1');
await page.click('#pad3');

console.log('--- 1. the page CSV ---');
{
  const csv = await page.evaluate(() => window.__export.csv());
  const lines = csv.trim().split(/\r?\n/);
  console.log(`  ${lines.length} lines`);
  for (const l of lines.slice(0, 4)) console.log(`    ${l}`);
  // the columns now include the SYMBOL and the event, because a click inside an order window has to say which
  // symbol it landed on - a wrong-window click is otherwise invisible
  check('the CSV has a header naming the units and the symbol',
    lines[0].startsWith('n,time_hh_mm_ss_cc,epoch_ms,target,symbol,event,gap_from_previous_ms'), lines[0]);
  check('one row per click', lines.length === 3, `${lines.length - 1} rows`);
  check('each row carries the hundredths time and the raw epoch ms',
    /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(lines[1].split(',')[1]) && /^\d{13}$/.test(lines[1].split(',')[2]),
    lines[1]);
}

console.log('\n--- 2. the page report names what was NOT clicked ---');
{
  const rep = await page.evaluate(() => window.__export.report());
  console.log(`  notClicked: ${JSON.stringify(rep.notClicked)}`);
  // two clicks landed, so six of the eight targets were not clicked: three points plus the three same-name ones
  check('it lists every target that received no click',
    Array.isArray(rep.notClicked) && rep.notClicked.length === 6,
    `${rep.notClicked.length}: ${rep.notClicked.join(', ')}`);
  check('and the two that were clicked are NOT in that list',
    !rep.notClicked.includes('نقطه ۱') && !rep.notClicked.includes('نقطه ۳'),
    rep.notClicked.join(', '));
  // the report's own shape: it lists the count per target and the list of ones that got nothing. The old
  // `wasClicked` boolean was replaced by `clicks`, so a target clicked twice is distinguishable from one clicked once.
  check('it reports a click count per target',
    rep.targets.every((t) => typeof t.clicks === 'string'), JSON.stringify(rep.targets).slice(0, 160));
  check('and the counts agree with the unclicked list',
    rep.targets.filter((t) => Number(t.clicks) === 0).map((t) => t.target).join(',') === rep.notClicked.join(','),
    `zero-count: ${rep.targets.filter((t) => Number(t.clicks) === 0).map((t) => t.target).join(',')}`);
  check('it records the timezone, so a schedule can be checked against it',
    Number.isFinite(rep.timezoneOffsetMin), String(rep.timezoneOffsetMin));
}

console.log('\n--- 3. the panel Log tab and its export ---');
{
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForTimeout(900);

  const tabs = await panel.evaluate(() => [...document.querySelectorAll('nav button')].map((b) => b.textContent));
  console.log(`  tabs: ${JSON.stringify(tabs)}`);
  check('a Log tab exists', tabs.some((x) => /Log|لاگ/i.test(x)), JSON.stringify(tabs));

  await panel.evaluate(() => {
    const btn = [...document.querySelectorAll('nav button')].find((b) => /Log|لاگ/i.test(b.textContent));
    btn?.click();
  });
  await panel.waitForTimeout(500);

  const shown = await panel.evaluate(() => ({
    hasIntro: !!document.body.innerText.match(/what the extension decided|آنچه افزونه/i),
    buttons: [...document.querySelectorAll('main button')].map((b) => b.textContent),
  }));
  console.log(`  buttons: ${JSON.stringify(shown.buttons)}`);
  check('the log tab explains itself', shown.hasIntro === true, String(shown.hasIntro));
  check('there is an export control', shown.buttons.some((b) => /export|خروجی/i.test(b ?? '')),
    JSON.stringify(shown.buttons));

  // download it for real
  const [download] = await Promise.all([
    panel.waitForEvent('download', { timeout: 15_000 }).catch(() => null),
    panel.evaluate(() => {
      const b = [...document.querySelectorAll('main button')].find((x) => /export|خروجی/i.test(x.textContent));
      b?.click();
    }),
  ]);

  if (download) {
    const p = await download.path();
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(p, 'utf8');
    console.log(`  downloaded ${download.suggestedFilename()} (${text.length} bytes)`);
    console.log('  --- first lines ---');
    for (const l of text.split('\n').slice(0, 12)) console.log(`    ${l}`);
    check('the download produced a text file', text.length > 200, `${text.length} bytes`);
    check('it names the build', text.includes(`version      : ${version}`), `expected ${version}`);
    check('it has a decision trail section', text.includes('start decisions'), '');
    check('it includes the page click log', text.includes('test-field click logs'), '');
    check('it includes the clicks the page recorded',
      /نقطه [۱۳]/.test(text), (text.match(/نقطه \S+/g) ?? []).slice(0, 4).join(', '));
  } else {
    check('the export produced a download', false, 'no download event');
  }
}

console.log('\n--- 3b. the log preserves the order events happened in ---');
{
  // The appends are queued through a promise chain to stop concurrent writes clobbering each other, and a queue is
  // only useful if it is FIFO. Asserted directly, because a log whose order is wrong is worse than no log.
  const probe = await ctx.newPage();
  await probe.goto(`chrome-extension://${extId}/options.html`);
  const ordered = await probe.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'clear-diagnostics' });
    // five sends in the same tick, deliberately not awaited one at a time
    await Promise.all([1, 2, 3, 4, 5].map((n) => chrome.runtime.sendMessage({ type: 'record-test-event', n })));
    const d = await chrome.runtime.sendMessage({ type: 'export-diagnostics', pageLogs: [] });
    if (!d?.ok) return { error: d?.error ?? 'export failed' };
    return { seq: (d.doc?.events ?? []).filter((e) => e.kind === 'ordering-probe').map((e) => e.n) };
  });
  if (ordered.error) console.log(`  export error: ${ordered.error}`);
  const seq = ordered.seq ?? [];
  console.log(`  five events sent in one tick came back as: ${JSON.stringify(seq)}`);
  check('all five were kept', seq.length === 5, `${seq.length}`);
  check('they are in the order they were sent', JSON.stringify(seq) === JSON.stringify([1, 2, 3, 4, 5]),
    JSON.stringify(seq));

}

console.log('\n--- 4. the decisions were actually recorded, not just the format ---');
{
  /**
   * Fired from an EXTENSION PAGE, not from the service worker.
   *
   * `runtime.sendMessage` sent from inside the service worker does not reach its own listener - the message goes
   * out and nothing handles it, so `evaluate` on the worker resolves to undefined and the test appears to crash
   * rather than to fail. That is a known trap in this codebase and the reason every other script here uses a
   * bridge page.
   */
  const bridge = await ctx.newPage();
  await bridge.goto(`chrome-extension://${extId}/options.html`);
  const res = await bridge.evaluate(async ({ tabId }) => {
    await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
      id: 'logtest', name: 'logtest', enabled: false, urls: [],
      // long enough that the second start certainly arrives while the first is still running - otherwise the
      // first has already finished and there is no collision to refuse, which is why this assertion passed
      // vacuously on the first attempt
      steps: [{ id: 'w', kind: 'wait', ms: 4000 }, { id: 'c', kind: 'click', finder: { strategy: 'css', selector: '#pad2' } }],
      schedule: { kind: 'manual' }, options: { stepDelayMs: 0 },
    } });
    /**
     * BOTH ISSUED IN THE SAME TICK, which is the only way to get a collision here.
     *
     * `start-run` does not resolve until the run has finished, so awaiting the first and then sending the second
     * gave the second a free slot and the "refusal" assertion passed vacuously. Two concurrent sends are what two
     * alarms on one second actually look like.
     */
    const both = await Promise.all([
      chrome.runtime.sendMessage({ type: 'start-run', automationId: 'logtest', tabId }).catch((e) => ({ ok: false, threw: String(e?.message ?? e) })),
      chrome.runtime.sendMessage({ type: 'start-run', automationId: 'logtest', tabId }).catch((e) => ({ ok: false, threw: String(e?.message ?? e) })),
    ]);
    const first = both[0];
    const second = both[1];
    await new Promise((r) => setTimeout(r, 6000));
    const doc = await chrome.runtime.sendMessage({ type: 'export-diagnostics', pageLogs: [] });
    return { first, second, text: doc?.text ?? '' };
  }, { tabId });

  console.log(`  first  start: ${JSON.stringify(res.first).slice(0, 110)}`);
  console.log(`  second start: ${JSON.stringify(res.second).slice(0, 160)}`);
  const trail = res.text.split('\n').filter((l) => /requested|ACCEPTED|REFUSED|finished/.test(l));
  for (const l of trail.slice(0, 8)) console.log(`    ${l}`);
  check('the refusal is in the export, with its reason',
    /REFUSED\s+logtest/.test(res.text), (trail.find((l) => /REFUSED/.test(l)) ?? 'not found in the export'));
  check('at least one event was recorded at all, so the log is not dead',
    /events: [1-9]/.test(res.text), (res.text.match(/events: \d+/)?.[0] ?? 'no events line'));
  check('the accepted start is in the export', /ACCEPTED\s+logtest/.test(res.text), '');
  check('the finish is in the export', /finished\s+logtest/.test(res.text), '');
}

await ctx.close();

console.log('\n' + '='.repeat(76));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);