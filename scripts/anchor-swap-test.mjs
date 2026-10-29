#!/usr/bin/env node
/**
 * Does anchoring actually survive the swap the user described?
 *
 * The earlier test proved the hazard existed (a positional selector redirects the click when a new window takes the
 * old one's place). This one proves the FIX: pick the buy button inside a window that identifies itself, drag the
 * window, open a second window at the old position, and check that a click through the saved finder still lands on
 * the original symbol.
 *
 * Both fixtures are used, because the two cases differ and only one of them is fixable by a better selector:
 *   - windows that carry data-symbol: anchoring makes the pick position-independent (this is the fix)
 *   - windows that are byte-identical: no selector can tell them apart, so the answer is a guard, not a selector
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 300)}` : ''}`);
};

function serve(fixturePath) {
  const html = readFileSync(fixturePath, 'utf8');
  const server = http.createServer((req, res) => {
    const mod = req.url.match(/^\/(finder|anchor)\.js$/);
    if (mod) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(readFileSync(path.join(ROOT, 'src', 'core', 'dom', `${mod[1]}.js`)));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return server;
}

const profile = mkdtempSync(path.join(os.tmpdir(), 'af-anchor-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
});

// ---------------------------------------------------------------------------------------------
// A. windows that identify themselves: the case the fix targets
// ---------------------------------------------------------------------------------------------
const serverA = serve(path.join(ROOT, 'tests', 'fixtures', 'floating-order.html'));
await new Promise((r) => serverA.listen(0, '127.0.0.1', r));
const urlA = `http://127.0.0.1:${serverA.address().port}/`;

const page = await ctx.newPage();
await page.goto(urlA);
await page.waitForFunction(() => typeof window.__openWindow === 'function');
await page.addScriptTag({ url: '/finder.js', type: 'module' }).catch(() => {});
await page.evaluate(async () => { window.__f = await import('/finder.js'); });

console.log('\n--- A. a window that carries data-symbol ---');
const pickedA = await page.evaluate(async () => {
  window.__openWindow('فزر');
  window.__openWindow('شستا');
  await new Promise((r) => setTimeout(r, 80));
  const [first, second] = window.__wins();
  const fa = window.__f.buildFinder(first.querySelector('.buy'));
  const fb = window.__f.buildFinder(second.querySelector('.buy'));
  return { fa, fb, firstSymbol: first.dataset.symbol, secondSymbol: second.dataset.symbol };
});
console.log(`  picker for ${pickedA.firstSymbol}: ${pickedA.fa.selector}`);
console.log(`  picker for ${pickedA.secondSymbol}: ${pickedA.fb.selector}`);
check('the picker ANCHORS to the symbol instead of a position',
  /data-symbol="فزر"/.test(pickedA.fa.selector ?? ''), pickedA.fa.selector);
check('the finder records that it is anchored', pickedA.fa.anchored === true, String(pickedA.fa.anchored));
check('two windows in the same page get DIFFERENT selectors',
  pickedA.fa.selector !== pickedA.fb.selector,
  `${pickedA.fa.selector}  vs  ${pickedA.fb.selector}`);
check('the positional path is kept as a fallback, not thrown away',
  Array.isArray(pickedA.fa.chain) && pickedA.fa.chain.length >= 1, JSON.stringify(pickedA.fa.chain));

console.log('\n--- A2. the swap: drag A away, then put a new window where A was ---');
const swapA = await page.evaluate(async () => {
  const [first, second] = window.__wins();
  const firstSymbol = first.dataset.symbol;
  const saved = window.__f.buildFinder(first.querySelector('.buy'));

  // move the first out of the way and open a NEW window at the position the first occupied
  first.style.left = '900px';
  first.style.top = '320px';
  const third = window.__openWindow('خودرو');
  third.style.left = '344px';
  third.style.top = '88px';

  await new Promise((r) => setTimeout(r, 80));
  window.__clicks = [];
  const resolved = window.__f.findElement(document, saved, { requireVisible: true });
  resolved?.element?.click();
  await new Promise((r) => setTimeout(r, 80));

  return {
    savedSelector: saved.selector,
    clickedSymbol: window.__clicks[0]?.symbol ?? null,
    wantedSymbol: firstSymbol,
    windowsOpen: window.__wins().length,
  };
});
console.log(`  saved selector : ${swapA.savedSelector}`);
console.log(`  window wanted  : ${swapA.wantedSymbol}`);
console.log(`  click landed on: ${swapA.clickedSymbol}`);
check('THE FIX: the click still lands on the picked symbol, not the new window',
  swapA.clickedSymbol === swapA.wantedSymbol,
  `landed on ${swapA.clickedSymbol}, wanted ${swapA.wantedSymbol}`);
check('and it did so with a third window sitting at the old position',
  swapA.windowsOpen === 3, `${swapA.windowsOpen} windows open`);

// ---------------------------------------------------------------------------------------------
// B. byte-identical windows: no selector can help, so the guard is the answer
// ---------------------------------------------------------------------------------------------
console.log('\n--- B. byte-identical windows: what the picker can and cannot do ---');
const serverB = serve(path.join(ROOT, 'tests', 'fixtures', 'floating-order-identical.html'));
await new Promise((r) => serverB.listen(0, '127.0.0.1', r));
const urlB = `http://127.0.0.1:${serverB.address().port}/`;

const pageB = await ctx.newPage();
await pageB.goto(urlB);
await pageB.waitForFunction(() => typeof window.__open === 'function');
await pageB.addScriptTag({ url: '/finder.js', type: 'module' }).catch(() => {});
await pageB.evaluate(async () => { window.__f = await import('/finder.js'); });

const identical = await pageB.evaluate(async () => {
  const a = window.__open(300, 80, 'فزر');
  const b = window.__open(700, 260, 'شستا');
  await new Promise((r) => setTimeout(r, 80));
  const fa = window.__f.buildFinder(a.querySelector('.buy'));
  const fb = window.__f.buildFinder(b.querySelector('.buy'));
  return {
    fa, fb,
    bothUnanchored: fa.anchored !== true && fb.anchored !== true,
    sameSelector: fa.selector === fb.selector,
    aMatches: document.querySelectorAll(fa.selector).length,
    bMatches: document.querySelectorAll(fb.selector).length,
  };
});
console.log(`  A: ${identical.fa.selector}  (${identical.aMatches} match)`);
console.log(`  B: ${identical.fb.selector}  (${identical.bMatches} match)`);
check('neither window can be anchored: there is nothing to anchor to',
  identical.bothUnanchored === true, `anchoredA=${identical.fa.anchored} anchoredB=${identical.fb.anchored}`);
check('so both are positional, and each is unique only BY POSITION',
  identical.aMatches === 1 && identical.bMatches === 1,
  `${identical.aMatches} / ${identical.bMatches}`);

// and the honest statement of the limit
const limit = await pageB.evaluate(async () => {
  const [a, b] = window.__wins();
  const saved = window.__f.buildFinder(a.querySelector('.buy'));
  a.remove();
  const c = window.__open(300, 80, 'خودرو');
  await new Promise((r) => setTimeout(r, 80));
  window.__clicks = [];
  window.__f.findElement(document, saved, { requireVisible: true })?.element?.click();
  await new Promise((r) => setTimeout(r, 80));
  return { clicked: window.__clicks[0]?.which ?? null, replacement: c.querySelector('.title').textContent };
});
console.log(`  after the swap the click landed on: ${limit.clicked}`);
check('a swap between byte-identical windows still redirects the click - the limit is real',
  limit.clicked !== 'فزر', `landed on ${limit.clicked}`);

await ctx.close();
serverA.close();
serverB.close();

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);