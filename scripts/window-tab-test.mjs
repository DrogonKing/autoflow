#!/usr/bin/env node
/**
 * THE WINDOW TAB, TESTED IN A REAL BROWSER AGAINST A REAL EXTENSION BUILD.
 *
 * WHAT IS BEING PROVEN, in the user's own terms:
 *   1. «بشه بهش زمان با دقت میلی ثانیه داد» - a start time with milliseconds is accepted, and the field keeps it.
 *   2. «انتهاش اجباری نباشه» - the end can be EMPTY, and when it is, the tab says the run will go until Stop.
 *   3. «به ترتیب نقاط انتخاب شده رو بزنه و اگر نقاط تموم شد دوباره بره از اول» - the points repeat in order. Engine behaviour,
 *      asserted in `tests/window.test.js`; here the wiring is proven, not the loop.
 *   4. the gap between clicks is settable, and defaults to zero.
 *
 * THE TAB IS LOADED AS THE REAL EXTENSION, not as a mocked module: the panel's boot sequence, its message channel and its
 * storage access are all exercised, because every one of those is a place this project has already had a fault that a unit test
 * could not see.
 */
import { mkdtempSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installProfileSweep } from './lib/profile.mjs';

installProfileSweep();

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.AUTOFLOW_CHROMIUM || '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  '} ${name}${detail ? `\n        ${String(detail).slice(0, 300)}` : ''}`);
};

const main = async () => {
  const dist = path.join(ROOT, 'dist');
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    console.log('dist/ not built');
    process.exit(1);
  }
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'autoflow-win-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: false,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) throw new Error('no service worker appeared at all');
  const extId = new URL(sw.url()).host;

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForFunction(() => document.querySelectorAll('nav.tabs button').length > 0, { timeout: 25000 });

  // ---- 1. the tab exists and is reachable
  const tabLabels = await panel.$$eval('nav.tabs button', (els) => els.map((e) => e.textContent.trim()));
  console.log('\n--- the tabs as offered ---');
  console.log('  ', JSON.stringify(tabLabels));
  check('a Window tab is offered', tabLabels.some((x) => /Window|پنجره/.test(x)), JSON.stringify(tabLabels));

  const opened = await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav.tabs button')].find((x) => /Window|پنجره/.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  });
  check('the Window tab can be opened', opened === true);

  await panel.waitForFunction(() => document.querySelector('.win-times .time-input') !== null, { timeout: 15000 }).catch(() => {});
  const present = await panel.evaluate(() => {
    const times = [...document.querySelectorAll('.win-times .time-input')];
    return {
      start: times.length >= 1,
      end: times.length >= 2,
      save: Boolean(document.querySelector('#win-save')),
      run: Boolean(document.querySelector('#win-run-now')),
      points: document.querySelectorAll('.win-step').length,
      addPoint: Boolean(document.querySelector('#win-add-point')),
      gapGear: Boolean(document.querySelector('.win-times .time-settings')),
      // THE COMPACT ROW: a pick button and a selector, and NOT the full editor's kind chooser
      pickButtons: document.querySelectorAll('.win-step .pick').length,
      kindChoosers: document.querySelectorAll('.win-step select').length,
    };
  });
  console.log('\n--- what the tab renders ---');
  console.log('  ', JSON.stringify(present));
  check('the start field exists', present.start === true);
  check('AND THE END FIELD EXISTS - it is optional, not absent', present.end === true);
  /**
   * REPORTED: «فایند رو متوجه نمیشم این همه گزینه داره مثل بیسیک فقط از pick استفاده کنه». A point is a pick and a selector; the
   * full editor's kind chooser has no place in a window, whose points are always clicks on a chosen element.
   */
  check('a point offers a Pick button, like Basic', present.pickButtons >= 1, String(present.pickButtons));
  check('and NO kind chooser, which is the clutter that was reported', present.kindChoosers === 0, String(present.kindChoosers));
  check('a save button exists', present.save === true);
  check('a run button exists', present.run === true);
  check('the tab starts with one point row, so it is usable without adding one first', present.points >= 1, String(present.points));
  check('a control to add points exists', present.addPoint === true);
  check('the gap control sits beside the times', present.gapGear === true);

  // ---- 2. the milliseconds survive a round trip through the field
  const startValue = await panel.evaluate(() => document.querySelectorAll('.win-times .time-input')[0].value);
  console.log('\n--- the start field as it opens ---');
  console.log('  value:', JSON.stringify(startValue));
  check('the start field opens with a millisecond-precision time, not an empty box',
    /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(startValue), startValue);
  check('the end field opens EMPTY, which is the endless mode',
    (await panel.evaluate(() => document.querySelectorAll('.win-times .time-input')[1]?.value)) === '');

  /**
   * THE REPORTED FAULT, tested the way a person types: DIGITS ONLY, ONE KEYSTROKE AT A TIME.
   *
   * «فرمت ساعتش مشکل داره و بین اعداد : نمیذاره» - the field would not accept a colon. Basic's `timeField` does not take one on
   * purpose: it keeps digits and inserts the separators itself. So the assertion is not "a colon is accepted" but the behaviour the
   * user actually wants - type 204445500 and read back 20:44:45.500.
   *
   * Typed with `type()` rather than `fill()`, because `fill()` sets the value in one go and would not exercise the per-keystroke
   * formatting (the same blind spot this project already recorded for `keyboard.insertText` and `maxlength`).
   */
  const startSel = '.win-times .time-input';
  await panel.click(startSel);
  await panel.evaluate(() => { document.querySelectorAll('.win-times .time-input')[0].select(); });
  await panel.type('.win-times .time-input', '204445500', { delay: 40 });
  await panel.evaluate(() => document.activeElement.blur());
  await panel.waitForTimeout(500);
  const kept = await panel.evaluate(() => document.querySelectorAll('.win-times .time-input')[0].value);
  console.log('\n--- typing 204445500 digits only ---');
  console.log('  field now reads:', JSON.stringify(kept));
  check('DIGITS ALONE ARE FORMATTED INTO A TIME, so the colons never have to be typed', kept === '20:44:45.500', kept);

  // the summary line must say what the empty end means, rather than leaving it to be guessed
  const summaryEndless = await panel.evaluate(() => {
    const n = document.querySelector('.win-summary');
    return n ? n.textContent.trim() : null;
  });
  console.log('\n--- the summary with an empty end ---');
  console.log('  ', JSON.stringify(summaryEndless));
  check('an empty end is described as running until Stop', Boolean(summaryEndless) && /Stop|استاپ/.test(summaryEndless), summaryEndless);

  // ---- 3. giving it an end changes the summary, so the two modes are distinguishable
  /**
   * THE END FIELD IS THE SECOND `timeField`, addressed by position because the component owns its own markup. Typed as DIGITS like
   * a person would, which is the behaviour that was asked for.
   */
  const endSel = '.win-times .time-input >> nth=1';
  await panel.click(endSel);
  await panel.evaluate(() => { document.querySelectorAll('.win-times .time-input')[1].select(); });
  await panel.type(endSel, '205033200', { delay: 40 });
  await panel.evaluate(() => document.activeElement.blur());
  await panel.waitForTimeout(700);
  const summaryFinite = await panel.evaluate(() => {
    const n = document.querySelector('.win-summary');
    return n ? n.textContent.trim() : null;
  });
  console.log('\n--- the summary with an end ---');
  console.log('  ', JSON.stringify(summaryFinite));
  check('with an end, the summary describes a bounded window', Boolean(summaryFinite) && summaryFinite !== summaryEndless, summaryFinite);

  // ---- 4. an end BEFORE the start is reported where the times are typed
  await panel.click(endSel);
  await panel.evaluate(() => { document.querySelectorAll('.win-times .time-input')[1].select(); });
  await panel.type(endSel, '203000000', { delay: 40 });
  await panel.evaluate(() => document.activeElement.blur());
  await panel.waitForTimeout(700);
  const errText = await panel.evaluate(() => {
    const n = document.querySelector('.win-error');
    return n ? n.textContent.trim() : null;
  });
  console.log('\n--- an end before the start ---');
  console.log('  ', JSON.stringify(errText));
  check('an end before the start is reported, not silently accepted', Boolean(errText), errText || '(no message)');
  check('and the message is a translated sentence, not an error code',
    Boolean(errText) && !/window\.err\./.test(errText), errText || '');

  // ---- 5. the gap box opens BESIDE the times, which is the placement the user asked for
  const gapBefore = await panel.evaluate(() => document.querySelectorAll('.gap-settings').length);
  await panel.click('.win-times .time-settings');
  await panel.waitForTimeout(500);
  const gapGeom = await panel.evaluate(() => {
    const box = document.querySelector('.gap-settings');
    const start = document.querySelector('.win-times .time-input');
    const end = document.querySelectorAll('.win-times .time-input')[1];
    if (!box || !start) return null;
    const b = box.getBoundingClientRect();
    const e = end ? end.getBoundingClientRect() : null;
    return {
      present: true,
      belowTheTimes: e ? b.top >= e.top : b.top >= start.getBoundingClientRect().top,
      inViewport: b.bottom <= window.innerHeight + 1,
      distanceBelowEnd: e ? Math.round(b.top - e.bottom) : null,
      fieldValue: document.querySelector('.gap-input')?.value ?? null,
    };
  });
  console.log('\n--- the gap box after pressing its gear ---');
  console.log('  ', JSON.stringify(gapGeom));
  check('pressing the gear opens the gap box', gapBefore === 0 && gapGeom?.present === true);
  check('the gap box sits directly under the times, not at the end of the form',
    gapGeom?.belowTheTimes === true, JSON.stringify(gapGeom));
  check('and it is on screen, not below the fold', gapGeom?.inViewport === true);
  check('the gap defaults to zero', gapGeom?.fieldValue === '0', String(gapGeom?.fieldValue));

  // ---- 6. the gap accepts Persian digits, the fault this project already paid for once
  await panel.fill('.gap-input', '۲۰۰');
  await panel.dispatchEvent('.gap-input', 'blur');
  await panel.waitForTimeout(400);
  const gapAfterPersian = await panel.evaluate(() => document.querySelector('.gap-input')?.value ?? null);
  console.log('\n--- the gap field after typing ۲۰۰ ---');
  console.log('  ', JSON.stringify(gapAfterPersian));
  check('the gap field accepts Persian digits and reads them as 200', gapAfterPersian === '200', String(gapAfterPersian));

  // ---- 7. no page errors anywhere in the tab
  const errors = [];
  panel.on('pageerror', (e) => errors.push(String(e.message)));
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav.tabs button')].find((x) => /Basic|ساده/.test(x.textContent));
    b?.click();
  });
  await panel.waitForTimeout(600);
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav.tabs button')].find((x) => /Window|پنجره/.test(x.textContent));
    b?.click();
  });
  await panel.waitForTimeout(600);
  console.log('\n--- page errors ---');
  console.log('  ', JSON.stringify(errors));
  check('moving between the Basic and Window tabs raises no page error', errors.length === 0, JSON.stringify(errors));

  // ---- 8. the Basic tab is unchanged, which matters because the gap strip was lifted out of it
  await panel.evaluate(() => {
    const b = [...document.querySelectorAll('nav.tabs button')].find((x) => /Basic|ساده/.test(x.textContent));
    b?.click();
  });
  await panel.waitForTimeout(700);
  const basic = await panel.evaluate(() => ({
    timeField: Boolean(document.querySelector('input.time-input')),
    points: document.querySelectorAll('.step').length,
    addPoint: [...document.querySelectorAll('button')].some((b) => /Add a point|افزودن نقطه/.test(b.textContent)),
  }));
  console.log('\n--- the Basic tab after the lift ---');
  console.log('  ', JSON.stringify(basic));
  check('the Basic tab still renders its own form', basic.timeField === true);
  check('and still offers its point list', basic.addPoint === true);

  await ctx.close();

  const failed = results.filter((r) => r.ok === false);
  console.log(`\n${results.length - failed.length} ok · ${failed.length} FAIL`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ${f.name} — ${f.detail ?? ''}`);
    process.exit(1);
  }
};

main().catch((e) => {
  console.error('the test itself threw:', e);
  process.exit(1);
});
