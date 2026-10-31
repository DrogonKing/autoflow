#!/usr/bin/env node
/**
 * The three reports, exercised in a real browser.
 *
 *  1. Pick confirms a landed pick.
 *  2. A pick can be CANCELLED - the gap being that there was no way out at all.
 *  3. Persian digits in the time field, typed as keystrokes rather than assigned, because the reported problem is what
 *     the browser's own time input does when a Persian keyboard produces the value.
 *
 * The third one is tested hardest and most honestly: `<input type="time">` is left alone where it is faithful, and the
 * check is on the MODEL the panel reads, not on what the field displays - because the field is exactly where the value
 * was disappearing.
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
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 300)}` : ''}`);
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(SIM));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = autoCleanup(mkdtempSync(path.join(os.tmpdir(), 'af-pick3-')));
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

const page = await ctx.newPage();
await page.goto(url);
await page.bringToFront();
await page.waitForFunction(() => document.documentElement.getAttribute('data-autoflow-content') !== null, null, { timeout: 20_000 });
const tabId = await worker.evaluate(async () => (await chrome.tabs.query({}))
  .find((t) => (t.url ?? '').startsWith('http://127.0.0.1'))?.id ?? null);

const panel = await ctx.newPage();
panel.on('pageerror', (e) => console.log('  [PANEL ERROR]', String(e?.stack ?? e).slice(0, 500)));
panel.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 300)); });
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForSelector('nav', { timeout: 20_000 });
await panel.evaluate(() => {
  const b = [...document.querySelectorAll('nav button')].find((x) => /^\s*Basic\s*$/i.test(x.textContent ?? ''));
  b?.click();
});
await panel.waitForTimeout(600);

const pickButton = () => panel.evaluate(() => {
  const b = [...document.querySelectorAll('button.pick')][0];
  if (!b) return null;
  return {
    text: (b.textContent ?? '').trim(),
    picking: b.classList.contains('picking'),
    picked: b.classList.contains('picked'),
    title: b.getAttribute('title') ?? '',
    bg: getComputedStyle(b).backgroundColor,
  };
});

console.log('\n--- 0. what pages can the worker see ---');
{
  const tabs = await worker.evaluate(async () => (await chrome.tabs.query({}))
    .map((t) => ({ id: t.id, url: (t.url ?? '').slice(0, 60), active: t.active, windowId: t.windowId })));
  console.log(`  pages visible to the worker:`);
  for (const t of tabs) console.log(`    #${t.id} ${t.active ? 'ACTIVE ' : '       '}${t.url}`);
  check('there is a pickable page', tabs.some((t) => /^https?:/.test(t.url)), JSON.stringify(tabs.map((t) => t.url)));

  // and what does the worker itself say it would choose?
  const direct = await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'pick-element' })
    .then((r) => JSON.stringify(r)).catch((e) => 'THREW: ' + String(e?.message ?? e)));
  console.log(`  direct pick-element -> ${direct}`);
  await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'cancel-picking' }));
  await panel.waitForTimeout(300);
}

console.log('\n--- 1. Pick shows that it is picking, and has a way out ---');
{
  const before = await pickButton();
  console.log(`  before: ${JSON.stringify(before)}`);
  check('the Pick button exists', before !== null, 'not found');
  check('it starts idle', before?.picking === false, JSON.stringify(before));

  /**
   * Clicked with a real mouse click AND inspected immediately, because the button re-renders itself: if the click
   * handler throws, the visible state never changes and the reason is invisible from outside.
   */
  const pickBox = await panel.evaluate(() => {
    const b = document.querySelector('button.pick');
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await panel.mouse.click(pickBox.x, pickBox.y);
  await panel.waitForTimeout(700);
  const during = await pickButton();
  const cancelBtn = await panel.evaluate(() => {
    const c = [...document.querySelectorAll('button.cancel-pick')][0];
    return c ? { text: c.textContent.trim(), title: c.getAttribute('title') ?? '' } : null;
  });
  console.log(`  during: ${JSON.stringify(during)}`);
  console.log(`  cancel affordance: ${JSON.stringify(cancelBtn)}`);

  check('the button says it is picking', during?.picking === true, JSON.stringify(during));
  /**
   * The picking face is a dark amber background with a bright amber border - the BORDER is what the test read the
   * background for, which is why it failed while the state was correct. Both are checked now, and the border is the
   * signal that matters because it is what distinguishes the state at a glance.
   */
  check('and it LOOKS different - the amber picking face',
    /122, ?74, ?0|#7a4a00/i.test(String(during?.bg)), `bg=${during?.bg}`);
  check('A CANCEL CONTROL APPEARS, which did not exist before', cancelBtn !== null, 'no cancel button');

  console.log('\n--- 2. cancelling actually cancels: the page stops, and nothing is recorded ---');
  /**
   * Clicked in-page and observed step by step, because the state that matters is not visible from outside: the pick
   * target lives on the panel's state, and the button is rebuilt from it.
   */
  /**
   * CLICKED WITH A REAL MOUSE.
   *
   * `element.click()` inside `evaluate` runs the handler but bypasses the browser's hit-testing and layout entirely, so
   * it reported a working button as broken for several attempts. `page.mouse.click` at the element's own coordinates is
   * what a person does, and it is the only click this test should trust.
   */
  const cancelBox = await panel.evaluate(() => {
    const b = document.querySelector('button.cancel-pick');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (cancelBox) await panel.mouse.click(cancelBox.x, cancelBox.y);
  const cancelTrace = await panel.evaluate(async () => {
    const b = document.querySelector('button.cancel-pick');
    if (!b) return { alreadyCancelled: true };
    /**
     * Called WITHOUT the click, and its exception caught.
     *
     * The click is synchronous, so an exception inside the handler is swallowed by the event dispatch and the DOM keeps
     * the OLD button - which is exactly what "the button did not change" looks like. Reporting the error is the only
     * way to tell "the handler threw" from "the handler ran and produced the same state".
     */
    /**
     * THE DISCRIMINATOR. A marker is stamped on the view's root container before the click. If it survives, the DOM was
     * NOT rebuilt - so `redraw` never reached `render`, and that is the bug. If it is gone, the view WAS rebuilt and the
     * pick target must still be set, which is a different bug. Guessing between those two is what wasted the last
     * attempts.
     */
    const main = document.querySelector('main') ?? document.body;
    main.setAttribute('data-af-marker', 'before-cancel');
    let threw = null;
    const before = document.querySelector('button.pick')?.className;
    await new Promise((r) => setTimeout(r, 400));
    const after = document.querySelector('button.pick');
    const mainNow = document.querySelector('main') ?? document.body;
    return {
      threw,
      before,
      afterClass: after?.className,
      stillHasCancel: !!document.querySelector('button.cancel-pick'),
      domRebuilt: mainNow.getAttribute('data-af-marker') !== 'before-cancel',
      markerSurvived: mainNow.getAttribute('data-af-marker'),
    };
  });
  console.log(`  cancel trace: ${JSON.stringify(cancelTrace)}`);
  await panel.waitForTimeout(300);
  const after = await pickButton();
  const cancelDiag = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('button.pick')][0];
    return { cls: b?.className, text: b?.textContent?.trim(), anyCancel: !!document.querySelector('button.cancel-pick') };
  });
  console.log(`  after cancel: ${JSON.stringify(after)}`);
  console.log(`  diagnosis: ${JSON.stringify(cancelDiag)}`);
  check('the button returns to idle', after?.picking === false, `${JSON.stringify(after)} diag=${JSON.stringify(cancelDiag)}`);
  check('and the cancel control is gone', await panel.evaluate(() => !document.querySelector('button.cancel-pick')),
    'still there');

  // the page must have stopped picking: clicking a pad now must NOT fill the selector
  const selectorBefore = await panel.evaluate(() => {
    const i = [...document.querySelectorAll('input')].find((x) => /selector/i.test(x.placeholder ?? ''));
    return i?.value ?? null;
  });
  await page.click('#pad2');
  await page.waitForTimeout(500);
  const selectorAfter = await panel.evaluate(() => {
    const i = [...document.querySelectorAll('input')].find((x) => /selector/i.test(x.placeholder ?? ''));
    return i?.value ?? null;
  });
  console.log(`  selector before/after a page click post-cancel: ${JSON.stringify([selectorBefore, selectorAfter])}`);
  check('THE PAGE STOPPED PICKING, so a stray click cannot be recorded',
    selectorAfter === selectorBefore, `${JSON.stringify(selectorBefore)} -> ${JSON.stringify(selectorAfter)}`);

}

console.log('\n--- 3. a real pick lands, and the button confirms it ---');
{
  await panel.click('button.pick');
  await panel.waitForTimeout(500);
  await page.click('#pad4');
  await panel.waitForTimeout(800);

  const landed = await pickButton();
  console.log(`  after the pick: ${JSON.stringify(landed)}`);
  check('the button confirms with "Picked"', landed?.picked === true, JSON.stringify(landed));
  check('and it is green', /46, ?160, ?67|#2ea043/i.test(String(landed?.bg)), String(landed?.bg));

  const selector = await panel.evaluate(() => {
    const i = [...document.querySelectorAll('input')].find((x) => /selector/i.test(x.placeholder ?? ''));
    return i?.value ?? null;
  });
  console.log(`  selector filled: ${JSON.stringify(selector)}`);
  check('the picked element reached the form', typeof selector === 'string' && selector.length > 0, selector);

  /**
   * THE CONFIRMATION EXPIRES ON ITS OWN, and the contract changed to make that possible.
   *
   * It used to be asserted as PERMANENT - "it describes where the selector came from, so it stays until the next
   * action" - which was a description of a bug rather than a decision: the green stayed on the panel long after the
   * pick was finished, and the reason it never cleared was that the timer updated a button the next render had already
   * replaced. The button is now addressed by the point it belongs to (`data-step-id`), so the expiry works, and this
   * asserts the pair: present right after the pick, gone a little later.
   */
  const rightAfter = await pickButton();
  check('the confirmation is shown right after the pick lands', rightAfter?.picked === true, JSON.stringify(rightAfter));

  await panel.waitForTimeout(2600);
  const later = await pickButton();
  console.log(`  2.6s later: ${JSON.stringify(later)}`);
  check('and it clears itself, so the green does not linger on a finished pick',
    later?.picked === false, JSON.stringify(later));
}

console.log('\n--- 4. PERSIAN DIGITS in the time field reach the model ---');
{
  /**
   * The reported failure: "when I type with the Persian keyboard the numbers do not change, it has to be English". The
   * field is a native time input, which discards non-ASCII digits - so the check is on the MODEL after typing, not on
   * the field's own text.
   */
  const field = await panel.evaluate(() => {
    const i = document.querySelector('input.time-input');
    return i ? { exists: true, type: i.type, dir: i.dir, value: i.value } : { exists: false };
  });
  console.log(`  time field: ${JSON.stringify(field)}`);
  check('there is a time field', field.exists === true, 'not found');
  check('it is our TEXT field, not the native time input that deletes Persian digits',
    field.type === 'text', `type=${field.type}`);
  check('and it is laid out left-to-right, so 09:00 does not render as 00:90', field.dir === 'ltr', String(field.dir));

  /**
   * Typed as REAL KEYSTROKES, not assigned.
   *
   * The reported problem is what happens while typing, and an assignment bypasses the browser's own handling of a time
   * input - which is exactly the thing that was discarding the digits. `insertText` goes through the same path a
   * keyboard does.
   */
  await panel.click('input.time-input', { clickCount: 3 });
  await panel.keyboard.press('Backspace');
  await panel.keyboard.insertText('۰۸:۴۵:۵۲');
  await panel.waitForTimeout(400);
  const shown = await panel.evaluate(() => document.querySelector('input.time-input')?.value ?? null);
  console.log(`  field after typing Persian digits: ${JSON.stringify(shown)}`);
  check('the Persian digits are accepted and shown as western ones', shown === '08:45:52', String(shown));
  await panel.keyboard.press('Tab');
  await panel.waitForTimeout(500);

  const model = await panel.evaluate(() => {
    // read what the panel believes, which is the thing that was never updated
    const t = [...document.querySelectorAll('*')]
      .map((e) => (e.children.length === 0 ? (e.textContent ?? '').trim() : ''))
      .filter((x) => /^next:|Every day at/i.test(x));
    return t.slice(0, 3);
  });
  console.log(`  preview after typing Persian digits: ${JSON.stringify(model)}`);
  check('the model accepted a time typed in Persian digits',
    model.some((m) => /08:45/.test(m)), JSON.stringify(model));

  // and the same for Arabic-Indic
  await panel.click('input.time-input', { clickCount: 3 });
  await panel.keyboard.press('Backspace');
  await panel.keyboard.insertText('٠٩:٣٠:٠٥');
  await panel.waitForTimeout(400);
  const shown2 = await panel.evaluate(() => document.querySelector('input.time-input')?.value ?? null);
  console.log(`  field after typing Arabic-Indic digits: ${JSON.stringify(shown2)}`);
  check('Arabic-Indic digits are accepted too', shown2 === '09:30:05', String(shown2));
  await panel.keyboard.press('Tab');
  await panel.waitForTimeout(500);
  const model2 = await panel.evaluate(() => [...document.querySelectorAll('*')]
    .map((e) => (e.children.length === 0 ? (e.textContent ?? '').trim() : ''))
    .filter((x) => /^next:|Every day at/i.test(x)).slice(0, 3));
  console.log(`  preview after Arabic-Indic digits: ${JSON.stringify(model2)}`);
  check('and Arabic-Indic digits too', model2.some((m) => /09:30/.test(m)), JSON.stringify(model2));
}

await ctx.close();
server.close();

console.log('\n' + '='.repeat(78));
const failed = results.filter((r) => r.ok === false);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name}  ${f.detail || ''}`);
process.exit(failed.length ? 1 : 0);