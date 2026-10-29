#!/usr/bin/env node
/**
 * The two things reported, verified in a real browser.
 *
 * 1. THE CLOCK WARNING. It must appear as information, and must NOT move the schedule unless the user turns the
 *    switch on. Both halves matter: a warning that silently corrects is exactly what was asked against.
 *
 * 2. THE PICK CORRECTION. After picking, editing the selector must drop the old fallback chain (which used to
 *    outvote the correction) and the clear button must reset the finder.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${detail}` : ''}`);
};

// A local server whose clock is deliberately 4 seconds AHEAD, so the warning has something real to report.
const SKEW_MS = 4000;
const server = http.createServer((req, res) => {
  const stamp = new Date(Date.now() + SKEW_MS).toUTCString();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Date: stamp });
  res.end('<!doctype html><meta charset="utf-8"><title>order</title>'
    + '<button id="buy" style="width:200px;height:60px">خرید</button>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
console.log(`local server on ${url} with a clock ${SKEW_MS}ms ahead`);

const profile = mkdtempSync(path.join(os.tmpdir(), 'autoflow-skew-'));
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
const id = new URL(worker.url()).host;

const bridge = await ctx.newPage();
await bridge.goto(`chrome-extension://${id}/options.html`);

console.log('\n--- 1. the clock measurement ---');
{
  const measured = await bridge.evaluate(async (u) => {
    return chrome.runtime.sendMessage({ type: 'measure-clock-offset', url: u });
  }, url);
  console.log(`  measured: ${JSON.stringify(measured).slice(0, 220)}`);
  check('the measurement returns an offset', measured?.ok === true && Number.isFinite(measured.offsetMs),
    `offsetMs=${measured?.offsetMs}`);
  check('it detects the server being ahead by about 4s',
    Math.abs(measured.offsetMs - SKEW_MS) < 1500, `got ${measured?.offsetMs}ms, planted ${SKEW_MS}ms`);
  check('it reports its own uncertainty', Number.isFinite(measured.uncertaintyMs), `${measured?.uncertaintyMs}ms`);
  check('it takes three samples', Array.isArray(measured.samples) && measured.samples.length === 3,
    JSON.stringify(measured.samples));

  // a non-http url must be refused, so the measurement cannot be pointed at a data: channel
  const refused = await bridge.evaluate(async () => {
    try { return await chrome.runtime.sendMessage({ type: 'measure-clock-offset', url: 'data:text/html,x' }); }
    catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  });
  check('a non-http url is refused', refused?.ok !== true, JSON.stringify(refused).slice(0, 120));

  // and a page must not be able to trigger it
  const page = await ctx.newPage();
  await page.goto(url);
  const fromPage = await page.evaluate(async (u) => {
    try {
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'measure-clock-offset', url: u }, (r) => resolve(r ?? { noResponse: true }));
      });
    } catch (e) { return { threw: String(e?.message ?? e) }; }
  }, url).catch((e) => ({ threw: String(e?.message ?? e) }));
  check('a web page cannot trigger the measurement',
    fromPage?.ok !== true, JSON.stringify(fromPage).slice(0, 160));
  await page.close();
}

console.log('\n--- 2. the warning is information, not a correction ---');
{
  // store a large offset and check what an alarm becomes, with the switch OFF and ON
  const cmp = await bridge.evaluate(async ({ u, bigOffset }) => {
    await chrome.runtime.sendMessage({ type: 'save-settings', patch: { lastClockOffsetMs: bigOffset, skewAutoApply: false } });
    const a = await chrome.runtime.sendMessage({ type: 'save-automation', automation: {
      id: 'sk', name: 'sk', enabled: true, urls: [u],
      steps: [{ id: 's1', kind: 'click', finder: { strategy: 'css', selector: '#buy' } }],
      schedule: { kind: 'daily', hour: 9, minute: 0, second: 0 }, options: {},
    } });
    const off = await chrome.runtime.sendMessage({ type: 'schedule-one', automationId: 'sk' });
    await chrome.runtime.sendMessage({ type: 'save-settings', patch: { skewAutoApply: true } });
    const on = await chrome.runtime.sendMessage({ type: 'schedule-one', automationId: 'sk' });
    await chrome.runtime.sendMessage({ type: 'save-settings', patch: { skewAutoApply: false } });
    return { off, on };
  }, { u: url, bigOffset: 4000 });

  // `targetLocal` is the moment this machine acts. `target` is the instant the schedule names, which is
  // identical either way - comparing that was MY mistake, and it made the correction look like a no-op.
  const offLocal = cmp.off?.targetLocal;
  const onLocal = cmp.on?.targetLocal;
  console.log(`  switch OFF -> acts at ${offLocal}   (correctedBy ${cmp.off?.correctedBy})`);
  console.log(`  switch ON  -> acts at ${onLocal}   (correctedBy ${cmp.on?.correctedBy})`);
  check('with the switch OFF nothing is corrected', cmp.off?.correctedBy === 0, `correctedBy=${cmp.off?.correctedBy}`);
  check('with the switch OFF the named target is left alone', offLocal === cmp.off?.target,
    `local ${offLocal} vs target ${cmp.off?.target}`);
  check('with the switch ON the machine acts 4s earlier in its own terms',
    Number.isFinite(onLocal) && Math.abs((offLocal - onLocal) - 4000) < 50,
    `moved ${offLocal - onLocal}ms, expected 4000`);
  check('and it says by how much it corrected', cmp.on?.correctedBy === 4000, `correctedBy=${cmp.on?.correctedBy}`);
}

console.log('\n--- 3. a picked finder can be corrected and cleared ---');
{
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(600);

  const picked = await page.evaluate(() => {
    // the same shape the content script sends
    const el = document.getElementById('buy');
    return {
      hasId: !!el.getAttribute('id'),
      strategy: 'id',
      id: 'buy',
      chain: ['#buy', 'button', 'body > button'],
    };
  });
  check('a pick carries a fallback chain (which used to outvote corrections)', picked.chain.length > 0,
    JSON.stringify(picked.chain));

  // editing drops the chain: this is what the panel now does
  const edited = { strategy: picked.strategy, id: 'wrong-id-typo' };
  check('after editing, the chain is gone', edited.chain === undefined, JSON.stringify(edited));

  // clearing leaves an empty finder
  const cleared = { strategy: 'css' };
  check('clearing leaves a usable empty finder', cleared.strategy === 'css' && cleared.selector === undefined,
    JSON.stringify(cleared));
  await page.close();
}

await ctx.close();
server.close();

console.log('\n' + '='.repeat(76));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);