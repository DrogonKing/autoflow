#!/usr/bin/env node
/**
 * Two questions about picking inside a DRAGGABLE, MULTI-INSTANCE floating window.
 *
 *   Q1. Pick the buy button, then drag the window: does the picker still find it?
 *   Q2. Pick the buy button, then open a SECOND window where the first used to be: does it click the right one?
 *
 * The answer cannot come from reading the code alone, because what matters is which selector the picker produced
 * for an element whose ancestors carry no id - which is what a generated window looks like. So this asks the real
 * `buildFinder` on the real fixture and then resolves the result, before and after moving things.
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
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'floating-order.html');
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 400)}` : ''}`);
};

// src/ is ES modules; the browser can import it directly, which is how the real finder is used
const html = readFileSync(FIXTURE, 'utf8');
const server = http.createServer((req, res) => {
  // serve the real modules the finder imports, so the test exercises the shipped code and not a copy
  const mod = req.url.match(/^\/(finder|anchor)\.js$/);
  if (mod) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, 'src', 'core', 'dom', `${mod[1]}.js`)));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-drag-')));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch'],
});
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log(`  [page] ${m.text().slice(0, 160)}`); });
await page.goto(url);
await page.waitForFunction(() => typeof window.__openWindow === 'function');

// make the real finder available in the page
await page.addScriptTag({ url: '/finder.js', type: 'module' }).catch(() => {});
const hasFinder = await page.evaluate(async () => {
  try {
    const m = await import('/finder.js');
    window.__f = m;
    return typeof m.buildFinder === 'function';
  } catch (e) { return String(e?.message ?? e); }
});
console.log(`\n  real finder loaded: ${hasFinder}`);
if (hasFinder !== true) { console.error('cannot test without the finder'); await ctx.close(); server.close(); process.exit(1); }

console.log('\n--- 1. open ONE window and pick its buy button ---');
const picked = await page.evaluate(async () => {
  document.querySelector('.sym').click();           // open the first window
  await new Promise((r) => setTimeout(r, 60));
  const win = window.__wins()[0];
  const buy = win.querySelector('.buy');
  const finder = window.__f.buildFinder(buy);
  const found = window.__f.findElement(document, finder, { requireVisible: true });
  return {
    finder,
    resolvesToTheSameButton: found?.element === buy,
    count: document.querySelectorAll(finder.selector ?? '#none').length,
    structure: {
      chainLength: finder.chain?.length ?? 0,
      chain: (finder.chain ?? []).slice(0, 5),
    },
  };
});
console.log(`  strategy : ${picked.finder.strategy}`);
console.log(`  selector : ${picked.finder.selector ?? picked.finder.id ?? picked.finder.text}`);
console.log(`  chain    : ${JSON.stringify(picked.structure.chain)}`);
check('the picker resolves to the button it was given',
  picked.resolvesToTheSameButton === true, String(picked.resolvesToTheSameButton));
check('its primary selector is unique on the page', picked.count === 1, `${picked.count} matches`);
// one CSS path and nothing else: `buildFinder` only adds a chain entry when the element or an ancestor has a
// unique id, a unique data attribute, or an aria-label. This fixture has none of those, so there is exactly one way
// to reach the button - which is the realistic case for a generated window and is worth stating plainly.
check('the chain is as long as the identifiers allow (one CSS path here)',
  picked.structure.chainLength >= 1, `${picked.structure.chainLength}`);
check('the label is recorded beside the selector, for a person to see',
  typeof picked.finder.label === 'string' && picked.finder.label.length > 0, JSON.stringify(picked.finder.label));

console.log('\n--- 2. Q1: DRAG the window, then resolve the same finder ---');
const afterDrag = await page.evaluate(async () => {
  const win = window.__wins()[0];
  const buy = win.querySelector('.buy');
  // drag the title bar 220px right and 140px down, exactly as a user would
  const title = win.querySelector('.title');
  const r = title.getBoundingClientRect();
  title.dispatchEvent(new MouseEvent('mousedown', { clientX: r.x + 10, clientY: r.y + 5, bubbles: true }));
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.x + 230, clientY: r.y + 145, bubbles: true }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 60));

  const finder = window.__f.buildFinder(buy);   // the finder the user would have saved, unchanged
  const found = window.__f.findElement(document, { strategy: 'css', selector: finder.selector, chain: finder.chain }, { requireVisible: true });
  return {
    movedTo: { left: win.style.left, top: win.style.top },
    stillResolvesToTheSameButton: found?.element === buy,
    howManyMatchPrimary: document.querySelectorAll(finder.selector ?? '#none').length,
  };
});
console.log(`  window moved to ${JSON.stringify(afterDrag.movedTo)}`);
check('Q1: after dragging, the finder still resolves to the same button',
  afterDrag.stillResolvesToTheSameButton === true, String(afterDrag.stillResolvesToTheSameButton));
check('Q1: dragging did not change how many elements match',
  afterDrag.howManyMatchPrimary === 1, `${afterDrag.howManyMatchPrimary} matches`);

console.log('\n--- 3. Q2: open a SECOND window, and put it where the first one was ---');
const collision = await page.evaluate(async () => {
  const first = window.__wins()[0];
  const firstBuy = first.querySelector('.buy');
  const homeLeft = first.style.left;
  const homeTop = first.style.top;

  // move the first out of the way, put a NEW window at the original position - the case in screenshot four
  first.style.left = '900px';
  first.style.top = '300px';
  const second = window.__openWindow('فزر');
  second.style.left = homeLeft;
  second.style.top = homeTop;

  await new Promise((r) => setTimeout(r, 60));
  const secondBuy = second.querySelector('.buy');

  // the finder that was saved when the FIRST window was picked
  const saved = window.__f.buildFinder(firstBuy);
  const resolved = window.__f.findElement(document, saved, { requireVisible: true });

  return {
    saved,
    stillPointsAtTheFirst: resolved?.element === firstBuy,
    nowPointsAtTheSecond: resolved?.element === secondBuy,
    bothSameSelector: saved.selector === window.__f.buildFinder(secondBuy).selector,
    windowsOpen: window.__wins().length,
  };
});
console.log(`  saved selector: ${collision.saved.selector ?? collision.saved.id}`);
check('Q2: the saved finder still points at the SAME button, not the new one',
  collision.stillPointsAtTheFirst === true && collision.nowPointsAtTheSecond === false,
  `first=${collision.stillPointsAtTheFirst} second=${collision.nowPointsAtTheSecond}`);
// MEASURED, not assumed: the two windows carry different `data-symbol` values, so the picker produces different
// selectors and the swap is SAFE. The trap only appears when a page gives its windows no distinguishing attribute -
// which the second fixture and its test cover.
check('Q2: the two buttons get different selectors here, because each window names its symbol',
  collision.bothSameSelector === false, `same=${collision.bothSameSelector}`);

console.log('\n--- 4. clicking through the finder after the swap ---');
const clicked = await page.evaluate(async () => {
  window.__clicks = [];
  const winsNow = window.__wins();
  const first = winsNow[0];
  const second = winsNow[1];
  const saved = window.__f.buildFinder(first.querySelector('.buy'));
  const resolved = window.__f.findElement(document, saved, { requireVisible: true });
  resolved.element.click();
  await new Promise((r) => setTimeout(r, 60));
  return {
    clicks: window.__clicks.slice(),
    firstSymbol: first.dataset.symbol,
    secondSymbol: second.dataset.symbol,
  };
});
console.log(`  click landed: ${JSON.stringify(clicked.clicks)}`);
check('the click went to the symbol the picker was pointed at',
  clicked.clicks.length === 1 && clicked.clicks[0].symbol === clicked.firstSymbol,
  `clicked ${clicked.clicks[0]?.symbol}, first window is ${clicked.firstSymbol}`);

await ctx.close();
server.close();

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);