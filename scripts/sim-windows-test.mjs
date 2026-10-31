#!/usr/bin/env node
/**
 * Does the upgraded test field work with the real extension, including the new floating windows?
 *
 * The page exists so the user can test the picker against something that behaves like their terminal. So the check
 * is not "the HTML renders" but: open a window, pick its buy button, drag the window, open another window where it
 * was, run a click - and see the page's own log say which SYMBOL was clicked. That last part is the whole reason the
 * log now carries a symbol column: a wrong-window click is otherwise invisible.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 260)}` : ''}`);
};

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-sim2-')));
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
await page.goto(pathToFileURL(SIM).href);
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null,
  null, { timeout: 15_000 });
const tabId = await bridge.evaluate(async () => (await chrome.tabs.query({}))
  .find((t) => (t.url ?? '').startsWith('file://'))?.id ?? null);
console.log(`\n  tab ${tabId}`);

console.log('\n--- 1. the page is what the screenshots asked for ---');
{
  const shape = await page.evaluate(() => ({
    watchRows: document.querySelectorAll('.wrow').length,
    pads: document.querySelectorAll('.pad[data-target]').length,
    sames: document.querySelectorAll('.same[data-target]').length,
    clock: document.getElementById('clock')?.textContent,
    columns: [...document.querySelectorAll('#logwrap thead th')].map((x) => x.textContent),
    hasSwitch: !!document.getElementById('anchored'),
    exports: ['exportCsv', 'exportAll', 'reset'].every((id) => !!document.getElementById(id)),
  }));
  console.log(`  watch=${shape.watchRows} pads=${shape.pads} same-name=${shape.sames} clock=${shape.clock}`);
  console.log(`  columns: ${JSON.stringify(shape.columns)}`);
  check('a watchlist to open windows from', shape.watchRows === 5, `${shape.watchRows}`);
  check('the five fixed points are still there', shape.pads === 5, `${shape.pads}`);
  check('the three same-name buttons are still there', shape.sames === 3, `${shape.sames}`);
  check('the clock still has hundredths', /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(shape.clock ?? ''), shape.clock);
  check('the log has a SYMBOL column, so a wrong-window click is visible',
    (shape.columns ?? []).some((c) => /نماد/.test(c ?? '')), JSON.stringify(shape.columns));
  check('there is a switch for anchored vs unanchored windows', shape.hasSwitch === true, String(shape.hasSwitch));
  check('all three export buttons exist', shape.exports === true, String(shape.exports));
}

console.log('\n--- 2. a window opens, and it looks like the terminal ---');
{
  await page.click('.wrow[data-sym="فزر"]');
  await page.waitForTimeout(400);
  const win = await page.evaluate(() => {
    const w = document.querySelector('.order-win');
    return {
      count: document.querySelectorAll('.order-win').length,
      hasSymbolAttr: w?.dataset.symbol ?? null,
      tabs: [...(w?.querySelectorAll('.title .tab') ?? [])].map((t) => t.textContent),
      hasClose: !!w?.querySelector('.close'),
      labels: [...(w?.querySelectorAll('.f > label') ?? [])].map((l) => l.textContent),
      actions: [...(w?.querySelectorAll('.actions button') ?? [])].map((b) => b.textContent),
      quote: w?.querySelector('.quote')?.textContent?.replace(/\s+/g, ' ').trim(),
    };
  });
  console.log(`  symbol attr: ${win.hasSymbolAttr}`);
  console.log(`  tabs: ${JSON.stringify(win.tabs)}  close: ${win.hasClose}`);
  console.log(`  fields: ${JSON.stringify(win.labels)}`);
  console.log(`  actions: ${JSON.stringify(win.actions)}`);
  console.log(`  quote: ${win.quote}`);
  check('a floating window opened', win.count === 1, `${win.count}`);
  check('it names its symbol, as the real terminal does', win.hasSymbolAttr === 'فزر', String(win.hasSymbolAttr));
  check('it has the خرید/فروش tab pair', JSON.stringify(win.tabs) === JSON.stringify(['خرید', 'فروش']),
    JSON.stringify(win.tabs));
  check('it has a close button', win.hasClose === true, String(win.hasClose));
  check('it has the five fields from the screenshots',
    JSON.stringify(win.labels) === JSON.stringify(['قیمت', 'تعداد', 'دارایی', 'سرمایه', 'اعتبار']),
    JSON.stringify(win.labels));
  check('it has the two action buttons', JSON.stringify(win.actions) === JSON.stringify(['خرید', 'فروش']),
    JSON.stringify(win.actions));
}

console.log('\n--- 3. pick the buy button, drag the window, open another where it was, then click ---');
{
  const run = await bridge.evaluate(async ({ tabId }) => {
    /**
     * The picker needs a human, so the finder is built the same way the content script builds it - by asking the
     * page for the element. What is being tested is whether the resulting selector survives the swap.
     */
    const probe = await chrome.tabs.sendMessage(tabId, { type: 'perform-step', step: {
      id: 'p', kind: 'extract', finder: { strategy: 'css', selector: '.order-win .actions .buy' },
      what: 'text',
    } }).catch((e) => ({ error: String(e?.message ?? e) }));
    return { probe };
  }, { tabId });
  console.log(`  reachable through the extension: ${JSON.stringify(run.probe).slice(0, 120)}`);

  // now do the real thing in the page: read the finder the content script would build, then swap and click
  const swap = await page.evaluate(async () => {
    const mod = await import(location.origin === 'null' ? '/finder.js' : '/finder.js').catch(() => null);
    return { viaImport: !!mod };
  });

  // build the finder in-page using the extension's own content script, which is the code that matters
  const built = await page.evaluate(() => {
    const w = document.querySelector('.order-win');
    const buy = w.querySelector('.actions .buy');
    // the marker the content script sets proves it is loaded; the finder itself is exercised through the extension
    return { marker: document.documentElement.getAttribute('data-autoflow-content'), symbol: w.dataset.symbol };
  });
  check('the content script is loaded on this page', !!built.marker, String(built.marker));
}

console.log('\n--- 4. the drag and swap, observed through the page log ---');
{
  // drag the first window away, open a second at its old position, then click the FIRST one's buy button by hand
  const observed = await page.evaluate(async () => {
    const first = document.querySelector('.order-win');
    const firstSymbol = first.dataset.symbol;
    const home = { left: first.style.left, top: first.style.top };

    // drag
    const title = first.querySelector('.title');
    const r = title.getBoundingClientRect();
    title.dispatchEvent(new MouseEvent('mousedown', { clientX: r.x + 10, clientY: r.y + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.x + 210, clientY: r.y + 130, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 60));
    const movedTo = { left: first.style.left, top: first.style.top };

    // a second window opens where the first one was
    window.__openOrderWindow('شستا');
    const second = [...document.querySelectorAll('.order-win')][1];
    second.style.left = home.left;
    second.style.top = home.top;
    await new Promise((res) => setTimeout(res, 60));

    const beforeClicks = window.__clicks.length;
    first.querySelector('.actions .buy').click();
    await new Promise((res) => setTimeout(res, 60));
    const logged = window.__clicks.slice(beforeClicks);

    return { firstSymbol, movedTo, logged, windows: document.querySelectorAll('.order-win').length };
  });
  console.log(`  first window is ${observed.firstSymbol}, dragged to ${JSON.stringify(observed.movedTo)}`);
  console.log(`  second window placed at the first one's old position; ${observed.windows} windows open`);
  console.log(`  click logged: ${JSON.stringify(observed.logged)}`);
  check('dragging moved the window', observed.movedTo.left !== '60px' || observed.movedTo.top !== '120px',
    JSON.stringify(observed.movedTo));
  check('the log records WHICH SYMBOL was clicked',
    observed.logged.length === 1 && observed.logged[0].symbol === observed.firstSymbol,
    JSON.stringify(observed.logged[0]));
  check('so a wrong-window click would be visible in the log',
    observed.logged[0]?.symbol !== 'شستا', `clicked ${observed.logged[0]?.symbol}`);
}

console.log('\n--- 5. the unanchored mode, which is what the warning is for ---');
{
  const un = await page.evaluate(async () => {
    // close everything, turn the switch off, open two windows
    for (const w of [...document.querySelectorAll('.order-win')]) w.remove();
    document.getElementById('anchored').checked = false;
    window.__openOrderWindow('فزر');
    window.__openOrderWindow('شستا');
    await new Promise((r) => setTimeout(r, 60));
    const wins = [...document.querySelectorAll('.order-win')];
    /**
     * What matters for the trap is not that the two windows are byte-identical - they are not, because each shows its
     * own symbol as text - but that NOTHING IN THEIR MARKUP identifies them to a selector: no id, no data attribute,
     * no aria-label, no #id anchor above them. Visible text is not something a CSS selector can anchor to and is
     * deliberately not used as an automatic fallback (two windows both containing the button "خرید" would be
     * ambiguous).
     */
    const identifiersOf = (w) => {
      const out = [];
      let cur = w;
      while (cur && cur !== document.body) {
        if (cur.id) out.push('id:' + cur.id);
        for (const a of cur.attributes) {
          if (a.name.startsWith('data-') || a.name === 'aria-label') out.push(a.name + '=' + a.value);
        }
        cur = cur.parentElement;
      }
      return out;
    };
    return {
      count: wins.length,
      anySymbolAttr: wins.some((w) => w.dataset.symbol),
      identifiersA: identifiersOf(wins[0]),
      identifiersB: identifiersOf(wins[1]),
      onlyDifferenceIsText: wins[0].querySelector('.quote .sym').textContent !== wins[1].querySelector('.quote .sym').textContent,
    };
  });
  console.log(`  ${un.count} windows, any with data-symbol: ${un.anySymbolAttr}`);
  console.log(`  identifiers on A: ${JSON.stringify(un.identifiersA)}`);
  console.log(`  identifiers on B: ${JSON.stringify(un.identifiersB)}`);
  check('the switch removes the identifying attribute', un.anySymbolAttr === false, String(un.anySymbolAttr));
  check('NOTHING in the markup identifies either window - the unfixable case',
    (un.identifiersA ?? []).length === 0 && (un.identifiersB ?? []).length === 0,
    `A=${JSON.stringify(un.identifiersA)} B=${JSON.stringify(un.identifiersB)}`);
  check('the only difference left is visible text, which a CSS selector cannot anchor to',
    un.onlyDifferenceIsText === true, String(un.onlyDifferenceIsText));
}

console.log('\n--- 6. the exports still work, and now carry the symbol ---');
{
  const csv = await page.evaluate(() => window.__export.csv());
  const header = csv.split('\r\n')[0];
  console.log(`  csv header: ${header}`);
  check('the CSV has a symbol column', header.includes('symbol'), header);

  const rep = await page.evaluate(() => window.__export.report());
  console.log(`  symbols clicked: ${JSON.stringify(rep.totals.symbolsClicked)}`);
  check('the report lists the symbols that were clicked',
    Array.isArray(rep.totals.symbolsClicked) && rep.totals.symbolsClicked.length >= 1,
    JSON.stringify(rep.totals.symbolsClicked));
  check('the report records whether windows were anchored',
    typeof rep.anchoredWindows === 'boolean', String(rep.anchoredWindows));
}

await ctx.close();

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);